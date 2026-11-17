import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectCore,
  expectedSha256For,
  installCore,
  normalizeCoreDir,
  readCoreMeta,
  sourceToArchiveUrl,
} from "./core";
import { DEFAULT_SOURCE_URL, PINNED_COMMIT, PINNED_SHA256 } from "./store";
import { statePaths } from "./paths";

const dirs: string[] = [];

function tempDir(prefix = "tc-core-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeCore(root: string) {
  const pkg = path.join(root, "todoocard_core");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "__init__.py"), "__version__ = '0.1.0'\n");
  fs.writeFileSync(path.join(pkg, "cli.py"), "def main():\n    return 0\n");
  fs.writeFileSync(path.join(root, "requirements.txt"), "bleak>=0.22,<2\nPillow>=10.0,<12\n");
}

describe("sourceToArchiveUrl", () => {
  it("仓库地址转 codeload tarball，默认 main", () => {
    expect(sourceToArchiveUrl("https://github.com/Gt841/plugin-todoocard-general-core"))
      .toBe("https://codeload.github.com/Gt841/plugin-todoocard-general-core/tar.gz/refs/heads/main");
  });

  it("commit 与 tree 都生成可复现的地址", () => {
    expect(sourceToArchiveUrl(`https://github.com/Gt841/plugin-todoocard-general-core/commit/${PINNED_COMMIT || "a".repeat(40)}`))
      .toBe(`https://codeload.github.com/Gt841/plugin-todoocard-general-core/tar.gz/${PINNED_COMMIT || "a".repeat(40)}`);
    expect(sourceToArchiveUrl("https://github.com/Gt841/plugin-todoocard-general-core/tree/dev"))
      .toBe("https://codeload.github.com/Gt841/plugin-todoocard-general-core/tar.gz/refs/heads/dev");
  });

  it("直链压缩包原样使用，非法地址报错", () => {
    expect(sourceToArchiveUrl("https://example.com/core.tar.gz")).toBe("https://example.com/core.tar.gz");
    expect(() => sourceToArchiveUrl("https://example.com/x")).toThrow("核心地址");
  });
});

describe("expectedSha256For", () => {
  it("默认 commit 使用预置摘要，其他来源不预置", () => {
    expect(PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(PINNED_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedSha256For(DEFAULT_SOURCE_URL)).toBe(PINNED_SHA256);
    expect(expectedSha256For("https://github.com/Gt841/plugin-todoocard-general-core")).toBeNull();
    expect(expectedSha256For(`https://github.com/Gt841/plugin-todoocard-general-core/commit/${"a".repeat(40)}`)).toBeNull();
  });
});

describe("normalizeCoreDir", () => {
  it("找到 tarball 内层目录并移动到 stage/core", () => {
    const root = tempDir();
    const raw = path.join(root, "raw");
    const nested = path.join(raw, "plugin-todoocard-general-core-abc");
    fs.mkdirSync(raw, { recursive: true });
    writeCore(nested);
    const layout = normalizeCoreDir(raw, path.join(root, "stage", "core"));
    expect(layout.ref).toBe("plugin-todoocard-general-core-abc");
    expect(fs.existsSync(path.join(layout.root, "todoocard_core", "cli.py"))).toBe(true);
  });

  it("拒绝缺少 todoocard_core 的目录", () => {
    const root = tempDir();
    const raw = path.join(root, "raw");
    fs.mkdirSync(raw, { recursive: true });
    expect(() => normalizeCoreDir(raw, path.join(root, "stage", "core"))).toThrow("不是 todoocard-general-core");
  });
});

describe("installCore", () => {
  it("下载、校验、原子替换并写入元数据", async () => {
    const root = tempDir();
    const stateDir = path.join(root, "state");
    const meta = await installCore({
      stateDir,
      sourceUrl: DEFAULT_SOURCE_URL,
      expectedSha256: null,
      downloader: async (_url, dest) => {
        fs.writeFileSync(dest, "fake archive");
      },
      extractor: async (_archive, dest) => {
        writeCore(path.join(dest, "plugin-todoocard-general-core-main"));
      },
      venvEnsurer: async () => {},
      verifier: async () => "todoocard-general-core 0.1.0",
    });
    expect(fs.existsSync(path.join(stateDir, "core", "todoocard_core", "cli.py"))).toBe(true);
    expect(meta.ref).toBe("plugin-todoocard-general-core-main");
    expect(readCoreMeta(stateDir)).toMatchObject({ sourceUrl: DEFAULT_SOURCE_URL, ref: meta.ref });
    expect(detectCore(stateDir).installed).toBe(true);
    expect(detectCore(stateDir).ready).toBe(false);
  });

  it("摘要不匹配时拒绝安装", async () => {
    const stateDir = tempDir("tc-core-state-");
    await expect(installCore({
      stateDir,
      sourceUrl: DEFAULT_SOURCE_URL,
      expectedSha256: "0".repeat(64),
      downloader: async (_url, dest) => { fs.writeFileSync(dest, "tampered"); },
      extractor: async () => { throw new Error("should not extract"); },
      venvEnsurer: async () => {},
      verifier: async () => "",
    })).rejects.toThrow("SHA-256");
    expect(detectCore(stateDir).installed).toBe(false);
  });

  it("下载失败时保留旧核心", async () => {
    const stateDir = tempDir("tc-core-state-");
    writeCore(path.join(stateDir, "core"));
    fs.writeFileSync(path.join(stateDir, "core-meta.json"), JSON.stringify({
      sourceUrl: DEFAULT_SOURCE_URL, archiveUrl: "old", ref: "old", sha256: "old", installedAt: 1,
    }));
    await expect(installCore({
      stateDir,
      sourceUrl: DEFAULT_SOURCE_URL,
      expectedSha256: null,
      downloader: async () => { throw new Error("network down"); },
      extractor: async () => {},
      venvEnsurer: async () => {},
      verifier: async () => "",
    })).rejects.toThrow("network down");
    expect(detectCore(stateDir).installed).toBe(true);
    expect(readCoreMeta(stateDir)?.ref).toBe("old");
  });
});

describe("detectCore", () => {
  it("venv 存在时才算 ready", () => {
    const stateDir = tempDir("tc-core-state-");
    writeCore(path.join(stateDir, "core"));
    expect(detectCore(stateDir).installed).toBe(true);
    expect(detectCore(stateDir).ready).toBe(false);
    const p = statePaths(stateDir);
    fs.mkdirSync(path.dirname(p.venvPython), { recursive: true });
    fs.writeFileSync(p.venvPython, "");
    expect(detectCore(stateDir).ready).toBe(true);
  });
});
