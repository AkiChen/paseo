import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  SessionMetadata,
  SessionMetadataReader,
  SessionMetadataSource,
} from "./session-metadata.js";

/**
 * The DSH project cache: `<home>/storages/session_projcache/sessions/<id>.json`,
 * one small `{ version, record }` document per session. DSH's own UI reads the
 * title and prompt from here, which is why the data is available at all.
 *
 * The layout is private and versioned (`version: 7`), so every field is read
 * defensively: a shape change costs the metadata, not the session list.
 */

const CACHE_RELATIVE_DIRECTORY = ["storages", "session_projcache", "sessions"];

export function createDshProjCacheReader(source: SessionMetadataSource): SessionMetadataReader {
  const home = source.home ?? "~/.dsh";
  return async (sessionId) => {
    const filePath = cacheFilePath(home, sessionId);
    try {
      const [contents, stats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
      return mergeLastActivity(parseDshProjCache(contents), stats.mtime);
    } catch {
      // A missing or unreadable cache is the normal case for sessions DSH has
      // not touched since the cache existed.
      return null;
    }
  };
}

/** Pure: the cache document, or null when it holds nothing usable. */
export function parseDshProjCache(contents: string): SessionMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const record = asRecord(asRecord(parsed)?.record);
  const rows = asRecord(record?.rows);
  const identity = asRecord(record?.identity);
  const metadata: SessionMetadata = {};
  const title = asText(rows?.title);
  if (title) {
    metadata.title = title;
  }
  const firstPrompt = asFirstPrompt(rows?.titleInput);
  if (firstPrompt) {
    metadata.firstPromptPreview = firstPrompt;
  }
  const lastPrompt = asLastPrompt(rows?.titleInput);
  if (lastPrompt && lastPrompt !== firstPrompt) {
    metadata.lastPromptPreview = lastPrompt;
  }
  const createdAt = asDate(identity?.createdAt);
  if (createdAt) {
    metadata.lastActivityAt = createdAt;
  }
  const conversation = hasConversation(rows?.titleInput, rows?.title);
  if (conversation !== undefined) {
    metadata.hasConversation = conversation;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * The cache counts the prompts it has seen, so a session that never recorded one
 * is empty rather than merely untitled. An unreadable count leaves the question
 * open, and the entry stays visible.
 */
function hasConversation(titleInput: unknown, title: unknown): boolean | undefined {
  const value = asRecord(asRecord(titleInput)?.val);
  if (!value) {
    return undefined;
  }
  const count = value.count;
  if (typeof count === "number") {
    return count > 0;
  }
  if (value.first !== null && value.first !== undefined) {
    return true;
  }
  return asText(title) ? true : undefined;
}

/**
 * DSH names cache files by the bare session id, while its ACP listing can hand
 * out the same id behind a `session-` prefix.
 */
export function normalizeDshSessionId(sessionId: string): string {
  return sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
}

function cacheFilePath(home: string, sessionId: string): string {
  const base = home === "~" || home.startsWith("~/") ? path.join(homedir(), home.slice(2)) : home;
  return path.join(base, ...CACHE_RELATIVE_DIRECTORY, `${normalizeDshSessionId(sessionId)}.json`);
}

function mergeLastActivity(
  metadata: SessionMetadata | null,
  modifiedAt: Date,
): SessionMetadata | null {
  if (!metadata) {
    return null;
  }
  const known = metadata.lastActivityAt?.getTime() ?? 0;
  return {
    ...metadata,
    lastActivityAt: known > modifiedAt.getTime() ? metadata.lastActivityAt : modifiedAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A cache cell is either a bare value or a `{ val: ... }` wrapper, and a text
 * cell may nest one more level as `{ text }`.
 */
function asText(cell: unknown): string | undefined {
  const value = asRecord(cell)?.val ?? cell;
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  const nested = asRecord(value);
  if (nested) {
    const text = nested.text ?? nested.value;
    if (typeof text === "string") {
      return text.trim() || undefined;
    }
  }
  return undefined;
}

function asFirstPrompt(titleInput: unknown): string | undefined {
  const raw = asRecord(titleInput)?.val ?? titleInput;
  const value = asRecord(raw);
  if (!value) {
    // A bare string where the cache usually wraps one.
    return asText(raw);
  }
  const first = asRecord(value.first);
  if (first) {
    const text = first.text ?? first.value;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  const messages = Array.isArray(value.messages) ? value.messages : [];
  for (const message of messages) {
    const text = asText(message);
    if (text) {
      return text;
    }
  }
  return asText(value);
}

function asLastPrompt(titleInput: unknown): string | undefined {
  const raw = asRecord(titleInput)?.val ?? titleInput;
  const value = asRecord(raw);
  if (!value) {
    return asText(raw);
  }
  const last = asRecord(value.last);
  if (last) {
    const text = last.text ?? last.value;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  const messages = Array.isArray(value.messages) ? value.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = asText(messages[index]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function asDate(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch milliseconds; seconds would land in 1970 and are worth refusing.
    const milliseconds = value > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
