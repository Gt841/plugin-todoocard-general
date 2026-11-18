import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_ASSETS,
  RUNTIME_RELEASE,
  RUNTIME_VERSION,
  installPythonRuntime,
  normalizeRuntimeDir,
  pythonRuntimeInstalled,
  readPythonRuntimeMeta,
  runtimeAsset,
  runtimeDownloadUrl,
} from "./pythonRuntime";

const dirs: string[] = [];

function tempDir(prefix = "tc-python-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeRuntime(root: string, platform = "darwin") {
  if (platform === "win32") {
    fs.writeFileSync(path.join(root, "python.exe"), "");
    return;
  }
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const python = path.join(bin, "python3");
  fs.writeFileSync(python, "#!/bin/sh\n");
  fs.chmodSync(python, 0o755);
}

describe("runtimeAsset", () => {
  it("按平台和架构选择上游资产，摘要固定", () => {
    expect(runtimeAsset("darwin", "arm64").asset)
      .toBe(`cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`);
    expect(runtimeAsset("darwin", "x64").asset)
      .toBe(`cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-x86_64-apple-darwin-install_only.tar.gz`);
    expect(runtimeAsset("win32", "x64").asset)
      .toBe(`cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`);
    expect(runtimeAsset("win32", "arm64").asset)
      .toBe(`cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-aarch64-pc-windows-msvc-install_only.tar.gz`);
    for (const item of Object.values(RUNTIME_ASSETS)) {
      expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(item.size).toBeGreaterThan(20 * 1024 * 1024);
    }
  });

  it("不支持的平台给出明确错误", () => {
    expect(() => runtimeAsset("linux", "x64")).toThrow("没有可用的内置 Python 运行时");
  });
});

describe("runtimeDownloadUrl", () => {
  it("指向 python-build-standalone 固定 release", () => {
    const asset = runtimeAsset("darwin", "arm64");
    expect(runtimeDownloadUrl(asset)).toBe(
      `https://github.com/astral-sh/python-build-standalone/releases/download/${RUNTIME_RELEASE}/${asset.asset}`,
    );
  });
});

describe("normalizeRuntimeDir", () => {
  it("把压缩包内层 python/ 移动到 stage", () => {
    const root = tempDir();
    const raw = path.join(root, "raw");
    const nested = path.join(raw, "python");
    fs.mkdirSync(nested, { recursive: true });
    writeRuntime(nested);
    expect(pythonRuntimeInstalled(path.join(root, "stage"), "darwin")).toBe(false);
    const stage = normalizeRuntimeDir(raw, path.join(root, "stage", "python"));
    expect(stage).toBe(path.join(root, "stage", "python"));
    expect(fs.existsSync(path.join(stage, "bin", "python3"))).toBe(true);
  });

  it("拒绝没有解释器的目录", () => {
    const root = tempDir();
    const raw = path.join(root, "raw");
    fs.mkdirSync(raw, { recursive: true });
    expect(() => normalizeRuntimeDir(raw, path.join(root, "stage"))).toThrow("不是有效的 Python 运行时");
  });
});

describe("installPythonRuntime", () => {
  it("下载、校验、解压并写入元数据", async () => {
    const stateDir = tempDir("tc-python-state-");
    const meta = await installPythonRuntime({
      stateDir,
      platform: "darwin",
      arch: "arm64",
      expectedSha256: null,
      downloader: async (_url, dest) => {
        fs.writeFileSync(dest, "fake runtime archive");
      },
      extractor: async (_archive, dest) => {
        const root = path.join(dest, "python");
        fs.mkdirSync(root, { recursive: true });
        writeRuntime(root);
      },
    });
    expect(meta.version).toBe(RUNTIME_VERSION);
    expect(meta.release).toBe(RUNTIME_RELEASE);
    expect(readPythonRuntimeMeta(stateDir)).toMatchObject({ version: RUNTIME_VERSION, release: RUNTIME_RELEASE });
    expect(pythonRuntimeInstalled(stateDir, "darwin")).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "python", "bin", "python3"))).toBe(true);
  });

  it("摘要不一致时拒绝安装且保留旧运行时", async () => {
    const stateDir = tempDir("tc-python-state-");
    writeRuntime(path.join(stateDir, "python"));
    await expect(installPythonRuntime({
      stateDir,
      platform: "darwin",
      arch: "arm64",
      expectedSha256: "0".repeat(64),
      downloader: async (_url, dest) => { fs.writeFileSync(dest, "tampered"); },
      extractor: async () => { throw new Error("should not extract"); },
    })).rejects.toThrow("校验失败");
    expect(pythonRuntimeInstalled(stateDir, "darwin")).toBe(true);
  });

  it("平台不支持时不发起下载", async () => {
    const stateDir = tempDir("tc-python-state-");
    let called = false;
    await expect(installPythonRuntime({
      stateDir,
      platform: "linux",
      arch: "x64",
      expectedSha256: null,
      downloader: async () => { called = true; },
      extractor: async () => {},
    })).rejects.toThrow("没有可用的内置 Python 运行时");
    expect(called).toBe(false);
  });
});
