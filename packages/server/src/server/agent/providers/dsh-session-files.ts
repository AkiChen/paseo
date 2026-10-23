import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Deleting a DSH-backed agent is two deletions: Paseo's own record, and the provider's session
 * log. DSH keeps that log outside Paseo, under `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/`,
 * plus a projection cache keyed by the bare session id. Paseo owns neither directory, so this
 * module treats them as an external store: exact names, validated ids, and no recursive sweep of
 * anything that does not match.
 *
 * The store is an implementation detail of DSH. If its layout changes, `deleteDshSessionFiles`
 * finds nothing and reports it as already absent; it never falls back to deleting a parent.
 */
export interface DeleteDshSessionFilesInput {
  /** `$DSH_HOME`, or the default `~/.dsh`. */
  home: string;
  /** The ACP session id Paseo persisted, e.g. `session-070eefc2-...`. */
  sessionId: string;
}

export interface DeleteDshSessionFilesResult {
  sessionDirectories: string[];
  projectionCacheFiles: string[];
}

const SAFE_SESSION_ID_PATTERN = /^(?:session-)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveDshHome(env: Record<string, string> | undefined): string {
  const configured = env?.DSH_HOME?.trim() || process.env.DSH_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".dsh");
}

/**
 * Removes the session log directory and the projection cache entry DSH keeps for it.
 *
 * Returns the paths actually removed so the caller can log them. A session that was never
 * persisted (or was already removed) is an empty result, not an error.
 */
export async function deleteDshSessionFiles(
  input: DeleteDshSessionFilesInput,
): Promise<DeleteDshSessionFilesResult> {
  const sessionId = input.sessionId.trim();
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Refusing to delete an unsafe provider session id: ${JSON.stringify(input.sessionId)}`,
    );
  }

  const home = path.resolve(input.home);
  const sessionDirectories = await findSessionDirectories(home, sessionId);
  const projectionCacheFiles = findProjectionCacheCandidates(home, sessionId);

  for (const directory of sessionDirectories) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  const deletedCacheFiles: string[] = [];
  for (const file of projectionCacheFiles) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      await fs.rm(file, { force: true, maxRetries: 10, retryDelay: 200 });
      deletedCacheFiles.push(file);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
  }

  return { sessionDirectories, projectionCacheFiles: deletedCacheFiles };
}

async function findSessionDirectories(home: string, sessionId: string): Promise<string[]> {
  const sessionsRoot = path.join(home, "sessions");
  const buckets = await readDirectoryEntries(sessionsRoot);
  const strippedId = sessionId.replace(/^session-/, "");
  const candidates = new Set([sessionId, strippedId, `session-${strippedId}`]);
  const matches: string[] = [];

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = path.join(sessionsRoot, bucket.name);
    const entries = await readDirectoryEntries(bucketPath);
    for (const entry of entries) {
      // Identity is the directory name under a session bucket. A session that was created but
      // never flushed a log still has to go, so the contents are not part of the test.
      if (entry.isDirectory() && candidates.has(entry.name)) {
        matches.push(path.join(bucketPath, entry.name));
      }
    }
  }

  return matches;
}

function findProjectionCacheCandidates(home: string, sessionId: string): string[] {
  const cacheRoot = path.join(home, "storages", "session_projcache", "sessions");
  const strippedId = sessionId.replace(/^session-/, "");
  const names = new Set([`${strippedId}.json`, `${sessionId}.json`]);
  return [...names].map((name) => path.join(cacheRoot, name));
}

async function readDirectoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
