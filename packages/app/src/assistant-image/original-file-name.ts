const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

export function originalImageFileName(source: string, mimeType: string): string {
  let pathname = source;
  if (/^(data:|blob:)/i.test(source)) {
    pathname = "";
  } else if (/^(https?:|file:)/i.test(source)) {
    pathname = new URL(source).pathname;
  }
  let name = pathname.replace(/\\/g, "/").split("/").pop() || "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // A literal percent in a local filename need not be URL-encoded.
  }
  name = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!name || name === "." || name === "..") name = "image";
  const extension = IMAGE_EXTENSIONS[mimeType.split(";", 1)[0].toLowerCase()];
  return extension && !/\.[a-z0-9]+$/i.test(name) ? `${name}.${extension}` : name;
}
