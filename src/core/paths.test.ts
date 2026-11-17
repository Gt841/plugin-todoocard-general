import path from "path";
import { describe, expect, it } from "vitest";
import { isInside, resolveStateDir, statePaths } from "./paths";

describe("resolveStateDir", () => {
  it("以 workspace 的 data/ 上一级为准（~/Library/Application Support/SiYuan/todoocard-general）", () => {
    const dir = resolveStateDir({
      userData: "/Users/me/Library/Application Support/SiYuan-Electron",
      dataDir: "/Users/me/Library/Application Support/SiYuan/data",
      home: "/Users/me",
      platform: "darwin",
    });
    expect(dir).toBe("/Users/me/Library/Application Support/SiYuan/todoocard-general");
  });

  it("没有 dataDir 时把 Electron 的 SiYuan-Electron 映射回 SiYuan", () => {
    const dir = resolveStateDir({
      userData: "/Users/me/Library/Application Support/SiYuan-Electron",
      home: "/Users/me",
      platform: "darwin",
    });
    expect(dir).toBe("/Users/me/Library/Application Support/SiYuan/todoocard-general");
  });

  it("非 macOS/Windows 且没有 userData 时使用 home 兜底", () => {
    const dir = resolveStateDir({ home: "/home/me", platform: "linux" });
    expect(dir).toBe("/home/me/.siyuan-todoocard-general");
  });
});

describe("isInside", () => {
  it("识别目录边界", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("statePaths", () => {
  it("所有状态文件都落在 stateDir 内", () => {
    const p = statePaths("/x/todoocard-general", "darwin");
    expect(p.stateFile).toBe(path.join("/x/todoocard-general", "state.json"));
    expect(p.coreDir).toBe(path.join("/x/todoocard-general", "core"));
    expect(p.coreMetaFile).toBe(path.join("/x/todoocard-general", "core-meta.json"));
    expect(p.venvDir).toBe(path.join("/x/todoocard-general", "venv"));
    expect(p.venvPython).toBe(path.join("/x/todoocard-general", "venv", "bin", "python"));
  });

  it("Windows venv 使用 Scripts/python.exe", () => {
    const p = statePaths("C:\\state", "win32");
    expect(p.venvPython).toBe(path.join("C:\\state", "venv", "Scripts", "python.exe"));
  });
});
