import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteDshSessionFiles, resolveDshHome } from "./dsh-session-files.js";

const SESSION_ID = "session-070eefc2-b229-4672-a602-310c0c588e12";
const SESSION_KEY = "070eefc2-b229-4672-a602-310c0c588e12";

describe("deleteDshSessionFiles", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-dsh-session-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeSession(bucket: string, directory: string): Promise<string> {
    const sessionDirectory = path.join(home, "sessions", bucket, directory);
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(sessionDirectory, "session.v4.jsonl.zstd"),
      Buffer.from("not a real log"),
    );
    return sessionDirectory;
  }

  async function writeCache(fileName: string): Promise<string> {
    const directory = path.join(home, "storages", "session_projcache", "sessions");
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, fileName);
    await fs.writeFile(file, "{}");
    return file;
  }

  it("removes the session directory and its projection cache", async () => {
    const sessionDirectory = await writeSession("--repo--", SESSION_ID);
    const cacheFile = await writeCache(`${SESSION_KEY}.json`);

    const result = await deleteDshSessionFiles({ home, sessionId: SESSION_ID });

    expect(result).toEqual({
      sessionDirectories: [sessionDirectory],
      projectionCacheFiles: [cacheFile],
    });
    await expect(fs.stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves another session in the same checkout alone", async () => {
    const target = await writeSession("--repo--", SESSION_ID);
    const sibling = await writeSession("--repo--", "session-cccccccc-b229-4672-a602-310c0c588e12");
    const siblingCache = await writeCache("cccccccc-b229-4672-a602-310c0c588e12.json");

    await deleteDshSessionFiles({ home, sessionId: SESSION_ID });

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(sibling)).resolves.toBeDefined();
    await expect(fs.stat(siblingCache)).resolves.toBeDefined();
  });

  it("finds a legacy directory named only by the bare session id", async () => {
    const sessionDirectory = await writeSession("--repo--", SESSION_KEY);

    const result = await deleteDshSessionFiles({ home, sessionId: SESSION_ID });

    expect(result.sessionDirectories).toEqual([sessionDirectory]);
    await expect(fs.stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a session by the bare id ACP returns", async () => {
    const directory = await writeSession("--repo--", SESSION_KEY);

    const result = await deleteDshSessionFiles({ home, sessionId: SESSION_KEY });

    expect(result.sessionDirectories).toEqual([directory]);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a session directory that has not flushed a log yet", async () => {
    const directory = path.join(home, "sessions", "--repo--", SESSION_ID);
    await fs.mkdir(directory, { recursive: true });

    const result = await deleteDshSessionFiles({ home, sessionId: SESSION_ID });

    expect(result.sessionDirectories).toEqual([directory]);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a missing session store as already absent", async () => {
    const result = await deleteDshSessionFiles({ home, sessionId: SESSION_ID });

    expect(result).toEqual({ sessionDirectories: [], projectionCacheFiles: [] });
  });

  it("refuses ids that could escape the session root", async () => {
    await expect(deleteDshSessionFiles({ home, sessionId: "../../etc/passwd" })).rejects.toThrow(
      "unsafe provider session id",
    );
    await expect(deleteDshSessionFiles({ home, sessionId: "a/b" })).rejects.toThrow(
      "unsafe provider session id",
    );
  });
});

describe("resolveDshHome", () => {
  it("prefers the provider's configured home", () => {
    expect(resolveDshHome({ DSH_HOME: "  /tmp/dsh-home  " })).toBe(path.resolve("/tmp/dsh-home"));
  });

  it("falls back to the default home", () => {
    expect(resolveDshHome({})).toBe(path.join(os.homedir(), ".dsh"));
  });
});
