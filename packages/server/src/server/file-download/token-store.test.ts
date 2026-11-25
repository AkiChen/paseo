import { describe, expect, it } from "vitest";
import { DownloadTokenStore } from "./token-store.js";

const file = {
  path: "out/clip.mp4",
  absolutePath: "/workspace/out/clip.mp4",
  fileName: "clip.mp4",
  mimeType: "video/mp4",
  size: 1024,
};

describe("DownloadTokenStore", () => {
  it("keeps a media token reusable until it expires", () => {
    let now = 1_000;
    const store = new DownloadTokenStore({
      ttlMs: 60_000,
      mediaTtlMs: 120_000,
      now: () => now,
    });

    const entry = store.issueMediaToken(file);
    expect(store.peekMediaToken(entry.token)?.absolutePath).toBe(file.absolutePath);
    expect(store.peekMediaToken(entry.token)?.absolutePath).toBe(file.absolutePath);

    now += 120_001;
    expect(store.peekMediaToken(entry.token)).toBeNull();
  });

  it("does not accept a media token as a download token", () => {
    const store = new DownloadTokenStore({ ttlMs: 60_000 });
    const media = store.issueMediaToken(file);

    expect(store.consumeToken(media.token)).toBeNull();
    // Consuming it as a download must not spend the media token.
    expect(store.peekMediaToken(media.token)?.token).toBe(media.token);
  });

  it("does not accept a download token on the media route", () => {
    const store = new DownloadTokenStore({ ttlMs: 60_000 });
    const download = store.issueToken(file);

    expect(store.peekMediaToken(download.token)).toBeNull();
    expect(store.consumeToken(download.token)?.token).toBe(download.token);
  });

  it("consumes a download token exactly once", () => {
    const store = new DownloadTokenStore({ ttlMs: 60_000 });
    const entry = store.issueToken(file);

    expect(store.consumeToken(entry.token)?.token).toBe(entry.token);
    expect(store.consumeToken(entry.token)).toBeNull();
  });
});
