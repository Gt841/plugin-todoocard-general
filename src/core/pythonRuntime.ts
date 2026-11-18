import fs from "fs";
import path from "path";
import { atomicReplaceDir, download, extractArchive, sha256File } from "./fsutil";
import { withDownloadMirror } from "./mirror";
import { runtimePythonPath, statePaths } from "./paths";

/**
 * 插件自带的 Python 运行时：从 astral-sh/python-build-standalone 下载官方
 * CPython 构建，校验钉死的 SHA-256 后解压到 `<stateDir>/python`。这样 macOS
 * 不需要 Xcode Command Line Tools，Windows 也不需要用户安装 python.org 的
 * 安装包或改 PATH。
 *
 * 运行时与 venv 分开存放：升级运行时只替换 `python/`，已有 venv 探测失败时
 * 由 ensureVenv 自动重建。
 */
export const RUNTIME_RELEASE = "20261110";
export const RUNTIME_VERSION = "3.12.16";
export const RUNTIME_PUBLISHER = "astral-sh/python-build-standalone";

export interface RuntimeAsset {
  asset: string;
  size: number;
  sha256: string;
}

/** 每个平台的 install_only 压缩包；摘要来自上游 release 的 digest。 */
export const RUNTIME_ASSETS: Record<string, RuntimeAsset> = {
  "darwin-arm64": {
    asset: `cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`,
    size: 25_371_130,
    sha256: "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f",
  },
  "darwin-x64": {
    asset: `cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-x86_64-apple-darwin-install_only.tar.gz`,
    size: 25_078_514,
    sha256: "83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc",
  },
  "win32-x64": {
    asset: `cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    size: 47_438_699,
    sha256: "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b",
  },
  "win32-arm64": {
    asset: `cpython-${RUNTIME_VERSION}+${RUNTIME_RELEASE}-aarch64-pc-windows-msvc-install_only.tar.gz`,
    size: 44_719_716,
    sha256: "7122bf62a0cf601527ba62e19ca715d64db86b269765da23937e9ac7f968f39c",
  },
};

export function runtimeAsset(platform: string = process.platform, arch: string = process.arch): RuntimeAsset {
  const asset = RUNTIME_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(`当前系统 ${platform}/${arch} 没有可用的内置 Python 运行时，请手动安装 Python 3.9+`);
  }
  return asset;
}

export function runtimeDownloadUrl(asset: RuntimeAsset): string {
  return `https://github.com/${RUNTIME_PUBLISHER}/releases/download/${RUNTIME_RELEASE}/${asset.asset}`;
}

export interface PythonRuntimeMeta {
  version: string;
  release: string;
  asset: string;
  sha256: string;
  installedAt: number;
}

export function readPythonRuntimeMeta(stateDir: string): PythonRuntimeMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePaths(stateDir).pythonRuntimeMetaFile, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.installedAt) return null;
    return {
      version: String(raw.version || ""),
      release: String(raw.release || ""),
      asset: String(raw.asset || ""),
      sha256: String(raw.sha256 || ""),
      installedAt: Number(raw.installedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** 只看文件是否存在且可执行；版本由 findPython 实际调用确认。 */
export function pythonRuntimeInstalled(stateDir: string, platform: string = process.platform): boolean {
  const bin = runtimePythonPath(path.join(stateDir, "python"), platform);
  try {
    if (!fs.statSync(bin).isFile()) return false;
    if (platform !== "win32") fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 压缩包解压后顶层是 `python/`。把包含解释器的那一层移动到 stage，保证升级
 * 是整目录替换，不会把旧版本文件留在新运行时里。
 */
export function normalizeRuntimeDir(rawDir: string, stageDir: string, platform: string = process.platform): string {
  const isRoot = (dir: string) => {
    try {
      return fs.statSync(runtimePythonPath(dir, platform)).isFile();
    } catch {
      return false;
    }
  };

  let source: string | null = null;
  if (isRoot(rawDir)) {
    source = rawDir;
  } else {
    for (const entry of fs.readdirSync(rawDir).filter((n) => !n.startsWith("."))) {
      const candidate = path.join(rawDir, entry);
      try {
        if (fs.statSync(candidate).isDirectory() && isRoot(candidate)) {
          source = candidate;
          break;
        }
      } catch {}
    }
  }
  if (!source) throw new Error("下载内容不是有效的 Python 运行时（缺少解释器）");
  fs.mkdirSync(path.dirname(stageDir), { recursive: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.renameSync(source, stageDir);
  return stageDir;
}

export interface InstallPythonRuntimeOptions {
  stateDir: string;
  /** 可选下载加速前缀，例如 https://gh-proxy.com/。 */
  mirror?: string;
  onProgress?: (message: string) => void;
  platform?: string;
  arch?: string;
  /** 测试用摘要覆盖：省略时按平台钉死摘要校验；null 表示跳过。 */
  expectedSha256?: string | null;
  downloader?: typeof download;
  extractor?: typeof extractArchive;
}

/**
 * 下载内置 Python 运行时并原子安装到 `<stateDir>/python`。调用方负责随后
 * 复查环境；这里不创建 venv，避免核心未安装时留下无用的虚拟环境。
 */
export async function installPythonRuntime(opts: InstallPythonRuntimeOptions): Promise<PythonRuntimeMeta> {
  const log = opts.onProgress || (() => {});
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const asset = runtimeAsset(platform, arch);
  const p = statePaths(opts.stateDir, platform);
  const downloader = opts.downloader || download;
  const extractor = opts.extractor || extractArchive;
  const directUrl = runtimeDownloadUrl(asset);
  const archiveUrl = withDownloadMirror(directUrl, opts.mirror);
  const expectedSha256 = opts.expectedSha256 === undefined ? asset.sha256 : opts.expectedSha256;
  const archive = path.join(p.tmpDir, "python-runtime.tar.gz");
  const rawDir = path.join(p.tmpDir, "python-raw");
  const stageDir = path.join(p.tmpDir, "python-stage");

  fs.mkdirSync(p.tmpDir, { recursive: true });
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });

  try {
    if (archiveUrl !== directUrl) log(`下载线路：第三方加速（原始地址 ${directUrl}）`);
    log(`下载内置 Python ${RUNTIME_VERSION}（约 ${Math.round(asset.size / 1024 / 1024)} MB）…`);
    await downloader(archiveUrl, archive, 10 * 60_000);
    const sha256 = sha256File(archive);
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(
        `内置 Python 下载校验失败，已拒绝安装（期望 ${expectedSha256.slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…）`,
      );
    }
    log("解压内置 Python 运行时…");
    await extractor(archive, rawDir, false);
    const root = normalizeRuntimeDir(rawDir, path.join(stageDir, "python"), platform);
    log("安装内置 Python 运行时…");
    atomicReplaceDir(root, p.pythonRuntimeDir);
    const meta: PythonRuntimeMeta = {
      version: RUNTIME_VERSION,
      release: RUNTIME_RELEASE,
      asset: asset.asset,
      sha256,
      installedAt: Date.now(),
    };
    fs.writeFileSync(p.pythonRuntimeMetaFile, JSON.stringify(meta, null, 2), "utf8");
    return meta;
  } finally {
    try { fs.unlinkSync(archive); } catch {}
    try { fs.rmSync(rawDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  }
}
