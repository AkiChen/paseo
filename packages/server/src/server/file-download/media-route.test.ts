import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { DownloadTokenStore } from "./token-store.js";
import { createMediaRouteHandler, MEDIA_ROUTE, parseSingleByteRange } from "./media-route.js";
import { isLoopbackRemoteAddress } from "../loopback.js";

const BYTES = Uint8Array.from({ length: 256 }, (_, index) => index);
const logger = { warn: () => undefined };

describe("parseSingleByteRange", () => {
  it("parses start-end, open-ended and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseSingleByteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  it("clamps an end past the file size", () => {
    expect(parseSingleByteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
  });

  it("rejects unsatisfiable and malformed ranges", () => {
    expect(parseSingleByteRange("bytes=100-", 100)).toBeNull();
    expect(parseSingleByteRange("bytes=20-10", 100)).toBeNull();
    expect(parseSingleByteRange("items=0-1", 100)).toBeNull();
    expect(parseSingleByteRange("bytes=-", 100)).toBeNull();
  });
});

describe("isLoopbackRemoteAddress", () => {
  it("accepts IPv4/IPv6 loopback and rejects an intranet peer", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("10.1.128.63")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});

describe("media route", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  let token: string;
  let store: DownloadTokenStore;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paseo-media-"));
    const filePath = join(directory, "clip.mp4");
    await writeFile(filePath, BYTES);

    store = new DownloadTokenStore({ ttlMs: 60_000 });
    const entry = store.issueMediaToken({
      path: "clip.mp4",
      absolutePath: filePath,
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      size: BYTES.byteLength,
    });
    token = entry.token;

    const app = express();
    app.get(
      MEDIA_ROUTE,
      createMediaRouteHandler({
        resolveToken: (candidate) => store.peekMediaToken(candidate),
        logger,
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}${MEDIA_ROUTE}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it("serves a complete file with media headers", async () => {
    const response = await fetch(`${baseUrl}?token=${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(BYTES.byteLength));
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(BYTES);
  });

  it("answers a range request with 206 and the requested bytes", async () => {
    const response = await fetch(`${baseUrl}?token=${token}`, {
      headers: { Range: "bytes=10-19" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(response.headers.get("content-length")).toBe("10");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(BYTES.subarray(10, 20));
  });

  it("answers HEAD without a body", async () => {
    const response = await fetch(`${baseUrl}?token=${token}`, {
      method: "HEAD",
      headers: { Range: "bytes=0-9" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  it("rejects an unknown token", async () => {
    const response = await fetch(`${baseUrl}?token=unknown`);
    expect(response.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    let now = 1_000;
    const expiring = new DownloadTokenStore({ ttlMs: 1, mediaTtlMs: 1, now: () => now });
    const entry = expiring.issueMediaToken({
      path: "clip.mp4",
      absolutePath: join(directory, "clip.mp4"),
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      size: BYTES.byteLength,
    });
    now += 2;
    expect(expiring.peekMediaToken(entry.token)).toBeNull();
  });

  it("answers an unsatisfiable range with 416", async () => {
    const response = await fetch(`${baseUrl}?token=${token}`, {
      headers: { Range: "bytes=999-" },
    });
    expect(response.status).toBe(416);
  });
});
