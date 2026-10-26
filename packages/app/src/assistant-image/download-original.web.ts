import { originalImageFileName } from "./original-file-name";

export async function downloadOriginalImage(input: { uri: string; source: string }): Promise<void> {
  const response = await fetch(input.uri);
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  // The display URI references the acquired original bytes, never a canvas or resized image.
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = originalImageFileName(input.source, blob.type);
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser/Electron download handler time to consume the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
