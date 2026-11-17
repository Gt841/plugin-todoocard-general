import { describe, expect, it } from "vitest";
import { IMAGE_EXTS, isImageFile, validateImageMeta } from "./image";

describe("isImageFile", () => {
  it("接受大小写混合的常见图片后缀", () => {
    for (const ext of IMAGE_EXTS) expect(isImageFile(`/tmp/a${ext.toUpperCase()}`)).toBe(true);
    expect(isImageFile("/tmp/a.txt")).toBe(false);
  });
});

describe("validateImageMeta", () => {
  it("拒绝超大文件、空尺寸和超大像素", () => {
    expect(() => validateImageMeta({ width: 10, height: 10, bytes: 101 * 1024 * 1024 })).toThrow("100 MB");
    expect(() => validateImageMeta({ width: 0, height: 10, bytes: 1 })).toThrow("尺寸");
    expect(() => validateImageMeta({ width: 10000, height: 6000, bytes: 1 })).toThrow("5000 万像素");
  });

  it("正常图片通过", () => {
    expect(() => validateImageMeta({ width: 528, height: 792, bytes: 1024 })).not.toThrow();
  });
});
