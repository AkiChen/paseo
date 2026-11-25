import { describe, expect, it } from "vitest";
import { isMediaFile, mediaKindOf, mediaMimeTypeOf } from "./media-types";

describe("media types", () => {
  it("maps the supported containers to a MIME type", () => {
    expect(mediaMimeTypeOf("out/clip.mp4")).toBe("video/mp4");
    expect(mediaMimeTypeOf("out/CLIP.MP4")).toBe("video/mp4");
    expect(mediaMimeTypeOf("out/clip.webm")).toBe("video/webm");
    expect(mediaMimeTypeOf("out/voice.mp3")).toBe("audio/mpeg");
    expect(mediaMimeTypeOf("out/voice.flac")).toBe("audio/flac");
  });

  it("does not claim containers the players cannot decode", () => {
    expect(isMediaFile("out/clip.mkv")).toBe(false);
    expect(isMediaFile("out/clip.avi")).toBe(false);
    expect(isMediaFile("out/notes.txt")).toBe(false);
    expect(isMediaFile("out/no-extension")).toBe(false);
  });

  it("separates video from audio", () => {
    expect(mediaKindOf("clip.mp4")).toBe("video");
    expect(mediaKindOf("clip.m4a")).toBe("audio");
    expect(mediaKindOf("clip.txt")).toBeNull();
  });
});
