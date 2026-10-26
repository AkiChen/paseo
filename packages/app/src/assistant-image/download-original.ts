import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import { originalImageFileName } from "./original-file-name";

export async function downloadOriginalImage(input: {
  uri: string;
  source: string;
}): Promise<"gallery" | void> {
  if (Platform.OS !== "android" && !(await Sharing.isAvailableAsync())) {
    throw new Error("File sharing is unavailable");
  }
  const directory = new Directory(Paths.cache, `paseo-image-download-${Date.now()}`);
  directory.create({ intermediates: true, idempotent: true });
  let file: File;
  let mimeType: string;
  if (input.uri.startsWith("file://")) {
    const original = new File(input.uri);
    mimeType = original.type;
    file = new File(directory, originalImageFileName(input.source, mimeType));
    original.copy(file);
  } else {
    const response = await fetch(input.uri);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    mimeType = response.headers.get("content-type") || "application/octet-stream";
    file = new File(directory, originalImageFileName(input.source, mimeType));
    file.write(new Uint8Array(await response.arrayBuffer()));
  }
  if (Platform.OS === "android") {
    try {
      const gallery = requireNativeModule<{
        saveImageAsync(uri: string, name: string): Promise<string>;
      }>("PaseoGallery");
      await gallery.saveImageAsync(file.uri, file.name);
      return "gallery";
    } finally {
      try {
        directory.delete();
      } catch (error) {
        // Cache cleanup must not turn a successful gallery save into a reported failure.
        console.warn("[AssistantImage] Temporary image cleanup failed", error);
      }
    }
  }
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: file.name });
}
