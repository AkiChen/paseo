import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type express from "express";
import { constants } from "node:fs";
import { isLoopbackRemoteAddress } from "../loopback.js";

const MEDIA_ROUTE = "/api/files/media";
const MEDIA_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

interface ByteRange {
  start: number;
  end: number;
}

export interface MediaRouteEntry {
  absolutePath: string;
  mimeType: string;
  fileName: string;
  size: number;
}

export interface MediaRouteOptions {
  /** Resolves a still-valid media token, or null when it expired or is unknown. */
  resolveToken: (token: string) => MediaRouteEntry | null;
  logger: { warn: (context: object, message: string) => void };
}

/**
 * Parse one RFC 9110 `Range: bytes=...` header against a known file size.
 *
 * Only a single satisfiable range is honoured: a player seeks to one point at a
 * time, and answering a multi-range request with `multipart/byteranges` needs
 * part boundaries the player rarely uses. Anything unusable returns null, which
 * the caller answers with the complete file (the conventional fallback for an
 * unparseable or unsupported range).
 */
export function parseSingleByteRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isSafeInteger(length) || length <= 0 || size === 0) {
      return null;
    }
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) {
    return null;
  }
  if (rawEnd === "") {
    return { start, end: size - 1 };
  }
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Serve one workspace media file over HTTP Range.
 *
 * The player (`<video>`/`<audio>`) discovers the bytes through this route, so the
 * response carries what a native media element needs to seek: `Accept-Ranges`,
 * `Content-Range`, `304`/`416` answers, conditional GETs and HEAD. Loopback is
 * the only accepted peer: a client reaches the daemon through its own SSH
 * tunnel or a same-machine connection, so this keeps an intranet-exposed daemon
 * from streaming a workspace to every host that can reach its port.
 */
export function createMediaRouteHandler(options: MediaRouteOptions): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) {
      res.status(400).json({ error: "Missing media token" });
      return;
    }
    const entry = options.resolveToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).end();
      return;
    }

    let fileHandle: FileHandle | null = null;
    try {
      fileHandle = await open(entry.absolutePath, MEDIA_OPEN_FLAGS);
      const stats = await fileHandle.stat();
      if (!stats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const size = stats.size;
      const etag = createWeakEtag(stats.mtimeMs, size);
      const lastModified = stats.mtime.toUTCString();
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastModified);
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (isNotModified(req, etag, lastModified)) {
        res.status(304).end();
        return;
      }

      const requestedRange = headerValue(req, "range");
      const ifRange = headerValue(req, "if-range");
      const rangeApplies =
        requestedRange !== undefined &&
        requestedRange !== "" &&
        (ifRange === undefined || ifRange === etag || ifRange === lastModified);
      const range = rangeApplies ? parseSingleByteRange(requestedRange, size) : null;

      if (range === null && rangeApplies) {
        // A parsed header that matches nothing is unsatisfiable (416), not a
        // request for the whole file.
        res.setHeader("Content-Range", `bytes */${size}`);
        res.status(416).end();
        return;
      }

      if (range === null) {
        res.setHeader("Content-Length", String(size));
        if (req.method === "HEAD") {
          res.status(200).end();
          return;
        }
        streamFile(res, fileHandle, { start: 0, end: size - 1 }, size, 200);
        fileHandle = null;
        return;
      }

      const length = range.end - range.start + 1;
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("Content-Length", String(length));
      if (req.method === "HEAD") {
        res.status(206).end();
        return;
      }
      streamFile(res, fileHandle, range, size, 206);
      fileHandle = null;
    } catch (error) {
      options.logger.warn({ err: error }, "Failed to stream media file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      } else {
        res.end();
      }
    } finally {
      // A streamed response owns the handle; HEAD and early exits still close it here.
      await fileHandle?.close().catch(() => undefined);
    }
  };
}

function streamFile(
  res: ServerResponse,
  fileHandle: FileHandle,
  range: ByteRange,
  size: number,
  status: number,
): void {
  // The handle is transferred to the stream (autoClose), so the caller leaves it
  // open on this path and the stream closes it when the response ends.
  const stream =
    range.start === 0 && range.end === size - 1
      ? fileHandle.createReadStream({ autoClose: true, start: 0 })
      : fileHandle.createReadStream({ autoClose: true, start: range.start, end: range.end });
  res.statusCode = status;
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end();
  });
  stream.pipe(res);
}

function createWeakEtag(mtimeMs: number, size: number): string {
  return `W/"${Math.round(mtimeMs)}-${size}"`;
}

function isNotModified(req: IncomingMessage, etag: string, lastModified: string): boolean {
  const ifNoneMatch = headerValue(req, "if-none-match");
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag);
  }
  const ifModifiedSince = headerValue(req, "if-modified-since");
  if (ifModifiedSince === undefined) {
    return false;
  }
  const since = Date.parse(ifModifiedSince);
  const modified = Date.parse(lastModified);
  return Number.isFinite(since) && Number.isFinite(modified) && modified <= since;
}

export { MEDIA_ROUTE };
