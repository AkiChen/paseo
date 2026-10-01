import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionMetadataReader,
  mergeSessionMetadata,
  resolveSessionMetadataSource,
  type ImportableSessionFields,
} from "./session-metadata.js";
import { createDshProjCacheReader, parseDshProjCache } from "./dsh-projcache-session-metadata.js";

const CACHE = JSON.stringify({
  version: 7,
  record: {
    identity: { formatVersion: 3, createdAt: 1_700_000_000_000, cwd: "/work/demo" },
    rows: {
      title: { val: "Fix the login bug" },
      titleInput: { val: { first: { text: "The login form drops the token" } } },
    },
  },
});

function emptyFields(): ImportableSessionFields {
  return {
    title: null,
    firstPromptPreview: null,
    lastPromptPreview: null,
    lastActivityAt: new Date(0),
  };
}

describe("resolveSessionMetadataSource", () => {
  it("reads the source a provider config asked for", () => {
    expect(
      resolveSessionMetadataSource({ sessionMetadata: { kind: "dsh-projcache", home: "~/.dsh" } }),
    ).toEqual({ kind: "dsh-projcache", home: "~/.dsh" });
  });

  it("ignores a provider that asked for nothing, or for an unknown store", () => {
    expect(resolveSessionMetadataSource({})).toBeNull();
    expect(resolveSessionMetadataSource(undefined)).toBeNull();
    expect(resolveSessionMetadataSource({ sessionMetadata: { kind: "someone-else" } })).toBeNull();
  });

  it("builds a reader only for a known kind", () => {
    expect(createSessionMetadataReader(null)).toBeNull();
    expect(createSessionMetadataReader({ kind: "dsh-projcache" })).toBeTypeOf("function");
  });
});

describe("parseDshProjCache", () => {
  it("reads the title, the first prompt, and the creation time", () => {
    const metadata = parseDshProjCache(CACHE);

    expect(metadata?.title).toBe("Fix the login bug");
    expect(metadata?.firstPromptPreview).toBe("The login form drops the token");
    expect(metadata?.lastActivityAt?.getTime()).toBe(1_700_000_000_000);
  });

  it("stays quiet on a store it does not recognise", () => {
    expect(parseDshProjCache("not json")).toBeNull();
    expect(parseDshProjCache(JSON.stringify({ version: 99, record: {} }))).toBeNull();
    expect(parseDshProjCache(JSON.stringify({ version: 99, record: { rows: {} } }))).toBeNull();
  });

  it("accepts a bare value where a wrapper is also possible", () => {
    const metadata = parseDshProjCache(
      JSON.stringify({
        record: { rows: { title: "Plain title", titleInput: { val: "Plain prompt" } } },
      }),
    );

    expect(metadata?.title).toBe("Plain title");
    expect(metadata?.firstPromptPreview).toBe("Plain prompt");
  });
});

describe("createDshProjCacheReader", () => {
  it("reads a session by id, with or without the ACP id prefix", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dsh-cache-"));
    const directory = path.join(home, "storages", "session_projcache", "sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "abc.json"), CACHE, "utf8");

    try {
      const reader = createDshProjCacheReader({ kind: "dsh-projcache", home });
      expect((await reader("abc"))?.title).toBe("Fix the login bug");
      expect((await reader("session-abc"))?.title).toBe("Fix the login bug");
      expect(await reader("missing")).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("mergeSessionMetadata", () => {
  it("fills what ACP left empty", () => {
    const merged = mergeSessionMetadata(emptyFields(), {
      title: "Fix the login bug",
      firstPromptPreview: "The login form drops the token",
      lastActivityAt: new Date("2026-04-30T10:00:00.000Z"),
    });

    expect(merged).toEqual({
      title: "Fix the login bug",
      firstPromptPreview: "The login form drops the token",
      lastPromptPreview: null,
      lastActivityAt: new Date("2026-04-30T10:00:00.000Z"),
    });
  });

  it("keeps whatever the provider did send", () => {
    const merged = mergeSessionMetadata(
      {
        title: "From ACP",
        firstPromptPreview: "From ACP",
        lastPromptPreview: null,
        lastActivityAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        title: "From the store",
        firstPromptPreview: "From the store",
        lastActivityAt: new Date("2026-05-05T00:00:00.000Z"),
      },
    );

    expect(merged.title).toBe("From ACP");
    expect(merged.firstPromptPreview).toBe("From ACP");
    expect(merged.lastActivityAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
  });

  it("changes nothing when the store had nothing", () => {
    const fields = emptyFields();
    expect(mergeSessionMetadata(fields, null)).toBe(fields);
  });
});

describe("empty session detection", () => {
  it("reports a session that never recorded a prompt", () => {
    const metadata = parseDshProjCache(
      JSON.stringify({
        record: {
          identity: { createdAt: 1_700_000_000_000 },
          rows: { title: { val: null }, titleInput: { val: { first: null, count: 0 } } },
        },
      }),
    );

    expect(metadata?.hasConversation).toBe(false);
    expect(metadata?.title).toBeUndefined();
  });

  it("reports a session with a prompt", () => {
    const metadata = parseDshProjCache(
      JSON.stringify({
        record: {
          rows: { title: { val: "Fix the login bug" }, titleInput: { val: { count: 3 } } },
        },
      }),
    );

    expect(metadata?.hasConversation).toBe(true);
    expect(metadata?.title).toBe("Fix the login bug");
  });

  it("leaves the question open when the store does not count prompts", () => {
    const metadata = parseDshProjCache(
      JSON.stringify({ record: { rows: { title: { val: "Titled" } } } }),
    );

    expect(metadata?.hasConversation).toBeUndefined();
  });
});
