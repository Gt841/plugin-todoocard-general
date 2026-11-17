import { describe, expect, it } from "vitest";
import { MIRROR_PRESETS, withDownloadMirror } from "./mirror";

const ARCHIVE = "https://codeload.github.com/Gt841/plugin-todoocard-general-core/tar.gz/refs/heads/main";

describe("withDownloadMirror", () => {
  it("空前缀保持直连", () => {
    expect(withDownloadMirror(ARCHIVE, "")).toBe(ARCHIVE);
    expect(withDownloadMirror(ARCHIVE)).toBe(ARCHIVE);
    expect(withDownloadMirror(ARCHIVE, "   ")).toBe(ARCHIVE);
  });

  it("在原始地址前拼接加速前缀，并去掉多余斜杠", () => {
    expect(withDownloadMirror(ARCHIVE, "https://gh-proxy.com/")).toBe(`https://gh-proxy.com/${ARCHIVE}`);
    expect(withDownloadMirror(ARCHIVE, "https://gh-proxy.com")).toBe(`https://gh-proxy.com/${ARCHIVE}`);
    expect(withDownloadMirror(ARCHIVE, "https://ghproxy.vip///")).toBe(`https://ghproxy.vip/${ARCHIVE}`);
  });

  it("非法前缀直接报错，避免把地址拼成非 http(s)", () => {
    expect(() => withDownloadMirror(ARCHIVE, "gh-proxy.com")).toThrow("http");
    expect(() => withDownloadMirror(ARCHIVE, "file:///tmp/")).toThrow("http");
  });
});

describe("MIRROR_PRESETS", () => {
  it("预置线路都使用 https 且以斜杠结尾", () => {
    for (const preset of MIRROR_PRESETS.filter((m) => m.value)) {
      expect(preset.value).toMatch(/^https:\/\/.+\/$/);
    }
  });
});
