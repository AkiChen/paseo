import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: { OS: "android" },
  save: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
  share: vi.fn(),
  available: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => ({ saveImageAsync: mocks.save }),
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.available,
  shareAsync: mocks.share,
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    create() {}
    delete() {
      mocks.remove();
    }
  },
  File: class {
    uri: string;
    name: string;
    type = "image/png";
    constructor(directoryOrUri: unknown, name?: string) {
      this.name = name ?? "original.png";
      this.uri = name ? "file:///cache/" + name : String(directoryOrUri);
    }
    copy(target: unknown) {
      mocks.copy(target);
    }
  },
}));

const { downloadOriginalImage } =
  await vi.importActual<typeof import("./download-original")>("./download-original.ts");

afterEach(() => {
  vi.resetAllMocks();
  mocks.platform.OS = "android";
});

describe("original image native destination", () => {
  const image = { uri: "file:///cache/original.png", source: "/workspace/plot.png" };

  it("saves Android originals to the gallery without opening a share sheet", async () => {
    mocks.save.mockResolvedValue("content://media/external/images/media/123");
    expect(await downloadOriginalImage(image)).toBe("gallery");
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith("file:///cache/plot.png", "plot.png");
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("reports a failed gallery write and cleans the temporary copy without sharing", async () => {
    mocks.save.mockRejectedValue(new Error("Storage full"));
    await expect(downloadOriginalImage(image)).rejects.toThrow("Storage full");
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("preserves the existing iOS share behavior", async () => {
    mocks.platform.OS = "ios";
    mocks.available.mockResolvedValue(true);
    await downloadOriginalImage(image);
    expect(mocks.share).toHaveBeenCalledWith("file:///cache/plot.png", {
      mimeType: "image/png",
      dialogTitle: "plot.png",
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("does not report a successful save as failed when temporary cleanup fails", async () => {
    mocks.save.mockResolvedValue("content://media/external/images/media/123");
    mocks.remove.mockImplementation(() => {
      throw new Error("Cache cleanup failed");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await downloadOriginalImage(image)).toBe("gallery");
      expect(mocks.share).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
