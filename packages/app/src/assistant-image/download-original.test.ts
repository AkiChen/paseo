import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { downloadOriginalImage } from "./download-original.web";
import { originalImageFileName } from "./original-file-name";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("originalImageFileName", () => {
  it.each([
    ["https://example.com/my%20image.png?token=secret", "image/png", "my image.png"],
    ["/workspace/chart", "image/webp", "chart.webp"],
    ["data:image/jpeg;base64,AA==", "image/jpeg", "image.jpg"],
    ["blob:preview", "image/png", "image.png"],
    ["/workspace/100%.png", "image/png", "100%.png"],
    ["file:///workspace/a%2Fb.png", "image/png", "a_b.png"],
  ])("names %s without leaking URL parameters", (source, mime, expected) => {
    expect(originalImageFileName(source, mime)).toBe(expected);
  });
});

describe("downloadOriginalImage on web", () => {
  it("downloads unchanged original bytes and releases the temporary URL", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("document", dom.window.document);
    const original = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const blob = new Blob([original], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal("fetch", fetchMock);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let suggestedName = "";
    vi.spyOn(dom.window.HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        suggestedName = this.download;
        expect(this.href).toBe("blob:download");
      },
    );

    await downloadOriginalImage({ uri: "blob:original", source: "/workspace/result.png" });

    expect(fetchMock).toHaveBeenCalledWith("blob:original");
    expect(suggestedName).toBe("result.png");
    expect(createUrl).toHaveBeenCalledWith(blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);
    expect(document.querySelector("a")).toBeNull();
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeUrl).toHaveBeenCalledWith("blob:download");
    dom.window.close();
  });

  it("rejects failed fetches instead of downloading an error response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      downloadOriginalImage({ uri: "https://example.com/image", source: "image" }),
    ).rejects.toThrow("403");
  });
});
