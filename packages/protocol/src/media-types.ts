/**
 * Inline media files (video / audio) the daemon streams to the client over HTTP
 * Range, and the media type each extension is served with.
 *
 * The list is deliberately narrow: these are the containers every supported
 * surface can decode natively (Chromium/Firefox/WebKit), so the pane never
 * promises playback it cannot deliver. Anything else keeps the existing binary
 * preview ("no preview available").
 */
export const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

const MEDIA_EXTENSIONS = new Set(Object.keys(MEDIA_MIME_TYPES));

export type MediaKind = "video" | "audio";

export function mediaExtensionOf(filePath: string): string | null {
  const normalized = filePath.trim().toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot < 0 || dot === normalized.length - 1) {
    return null;
  }
  const extension = normalized.slice(dot + 1);
  return MEDIA_EXTENSIONS.has(extension) ? extension : null;
}

/** The MIME type a workspace path is streamed with, or null when it is not media. */
export function mediaMimeTypeOf(filePath: string): string | null {
  const extension = mediaExtensionOf(filePath);
  return extension === null ? null : (MEDIA_MIME_TYPES[extension] ?? null);
}

/** Whether the file should open in the media preview instead of the text/binary one. */
export function isMediaFile(filePath: string): boolean {
  return mediaMimeTypeOf(filePath) !== null;
}

export function mediaKindOf(filePath: string): MediaKind | null {
  const mimeType = mediaMimeTypeOf(filePath);
  if (mimeType === null) {
    return null;
  }
  return mimeType.startsWith("audio/") ? "audio" : "video";
}
