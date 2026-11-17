import fs from "fs";
import path from "path";
import { atomicReplaceDir, download, extractArchive, isZipUrl, runSpawn, sha256File, which } from "./fsutil";
import { withDownloadMirror } from "./mirror";
import { statePaths } from "./paths";
import { DEFAULT_SOURCE_URL, PINNED_COMMIT, PINNED_SHA256 } from "./store";
import type { CoreView, PrereqView } from "../types";

export { DEFAULT_SOURCE_URL };

/** 只有维护者钉死的默认 commit 才有可预知的摘要；用户换源后只记录实际值。 */
export function expectedSha256For(sourceUrl: string): string | null {
  const m = sourceUrl.trim().match(
    /^https?:\/\/github\.com\/gt841\/plugin-todoocard-general-core\/commit\/([0-9a-f]{40})\/?$/i,
  );
  if (!m || !PINNED_COMMIT || !PINNED_SHA256) return null;
  return m[1].toLowerCase() === PINNED_COMMIT ? PINNED_SHA256 : null;
}

export interface CoreMeta {
  sourceUrl: string;
  archiveUrl: string;
  ref: string;
  sha256: string;
  installedAt: number;
}

const GITHUB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\/(tree|commit)\/([^/]+))?\/?$/i;

/** 把常见的 GitHub 仓库地址转换成 codeload tarball 地址；直链压缩包原样使用。 */
export function sourceToArchiveUrl(source: string, ref = "main"): string {
  const value = source.trim();
  if (/\.(tar\.gz|tgz|zip)(\?|#|$)/i.test(value)) return value;
  const m = value.match(GITHUB_RE);
  if (!m) throw new Error("核心地址需为 GitHub 仓库、commit 或 .tar.gz/.zip 直链");
  const owner = m[1];
  const repo = m[2];
  const kind = m[3];
  const target = m[4] || ref;
  const suffix = kind === "commit" ? target : `refs/heads/${target}`;
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${suffix}`;
}

export interface CoreLayout {
  root: string;
  ref: string;
}

export function isCoreRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "todoocard_core", "cli.py"))
    && fs.existsSync(path.join(dir, "todoocard_core", "__init__.py"));
}

/**
 * GitHub tarball 解压后通常只有一层 `plugin-todoocard-general-core-main/`。
 * 找到包含 `todoocard_core/` 的那一层并移动到 stage/core，保证更新始终是整
 * 目录替换，不会出现新旧模块混在一起。
 */
export function normalizeCoreDir(rawDir: string, stageRoot: string): CoreLayout {
  let source: string | null = null;
  let ref = "";
  if (isCoreRoot(rawDir)) {
    source = rawDir;
  } else {
    const entries = fs.readdirSync(rawDir).filter((n) => !n.startsWith("."));
    for (const entry of entries) {
      const candidate = path.join(rawDir, entry);
      if (fs.statSync(candidate).isDirectory() && isCoreRoot(candidate)) {
        source = candidate;
        ref = entry;
        break;
      }
    }
  }
  if (!source) throw new Error("下载内容不是 todoocard-general-core（缺少 todoocard_core/cli.py）");
  fs.mkdirSync(path.dirname(stageRoot), { recursive: true });
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.renameSync(source, stageRoot);
  return { root: stageRoot, ref };
}

export function readCoreMeta(stateDir: string): CoreMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePaths(stateDir).coreMetaFile, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.installedAt) return null;
    return {
      sourceUrl: String(raw.sourceUrl || DEFAULT_SOURCE_URL),
      archiveUrl: String(raw.archiveUrl || ""),
      ref: String(raw.ref || ""),
      sha256: String(raw.sha256 || ""),
      installedAt: Number(raw.installedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function detectCore(stateDir: string, sourceUrl = DEFAULT_SOURCE_URL): CoreView {
  const p = statePaths(stateDir);
  const installed = isCoreRoot(p.coreDir);
  const meta = readCoreMeta(stateDir);
  const venvReady = fs.existsSync(p.venvPython);
  return {
    installed,
    ready: installed && venvReady,
    sourceUrl: meta?.sourceUrl || sourceUrl,
    archiveUrl: meta?.archiveUrl || "",
    ref: meta?.ref || "",
    sha256: meta?.sha256 || "",
    installedAt: meta?.installedAt || 0,
    coreDir: p.coreDir,
    venvDir: p.venvDir,
    venvPython: p.venvPython,
  };
}

export interface PythonRuntime {
  cmd: string;
  args: string[];
  version: string;
}

const PY_VERSION_CHECK = "import sys;print('%d.%d.%d' % sys.version_info[:3])";

function pythonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

/**
 * 找到可用的 Python 3.9+。Windows 优先用 `py -3` 启动器，避免商店占位
 * `python.exe`；环境变量 SIYUAN_TODOOCARD_PYTHON 可指定绝对路径。
 */
export async function findPython(): Promise<PythonRuntime | null> {
  const forced = (process.env.SIYUAN_TODOOCARD_PYTHON || "").trim();
  const candidates: { cmd: string; args: string[] }[] = [];
  if (forced) candidates.push({ cmd: forced, args: [] });
  if (process.platform === "win32") {
    candidates.push({ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] }, { cmd: "python3", args: [] });
  } else {
    candidates.push({ cmd: "python3", args: [] }, { cmd: "python", args: [] });
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = await which(candidate.cmd);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const r = await runSpawn(resolved, [...candidate.args, "-c", PY_VERSION_CHECK], {
      env: pythonEnv(),
      timeoutMs: 15000,
    });
    if (r.code !== 0 || r.timedOut) continue;
    const m = r.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)$/m);
    if (!m) continue;
    if (Number(m[1]) !== 3 || Number(m[2]) < 9) continue;
    return { cmd: resolved, args: candidate.args, version: m[0] };
  }
  return null;
}

async function verifyCoreModule(stateDir: string): Promise<string> {
  const p = statePaths(stateDir);
  const r = await runSpawn(p.venvPython, ["-m", "todoocard_core", "--version"], {
    cwd: p.coreDir,
    env: pythonEnv(),
    timeoutMs: 60000,
  });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(-400) || `exit ${r.code}`;
    throw new Error(`核心自检失败：${detail}`);
  }
  return r.stdout.trim();
}

export interface EnsureVenvOptions {
  stateDir: string;
  onProgress?: (message: string) => void;
  python?: PythonRuntime | null;
  pythonFinder?: typeof findPython;
}

/**
 * 在插件数据目录创建独立 venv，并把核心依赖装进去。venv 放在核心目录之外，
 * 所以重新下载核心不会把已装好的依赖一起删掉。
 */
export async function ensureVenv(opts: EnsureVenvOptions): Promise<void> {
  const log = opts.onProgress || (() => {});
  const p = statePaths(opts.stateDir);
  let python = opts.python || null;

  if (fs.existsSync(p.venvPython)) {
    const probe = await runSpawn(p.venvPython, ["-c", "import sys;print(sys.version_info[0])"], {
      env: pythonEnv(),
      timeoutMs: 15000,
    });
    if (probe.code !== 0 || probe.stdout.trim() !== "3") {
      log("现有虚拟环境不可用，重新创建…");
      fs.rmSync(p.venvDir, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(p.venvPython)) {
    python = python || await (opts.pythonFinder || findPython)();
    if (!python) {
      throw new Error(
        process.platform === "win32"
          ? "未找到 Python 3.9+：请从 python.org 安装，并勾选 Add python.exe to PATH"
          : "未找到 Python 3.9+：请先安装 Python 3，或在 macOS 执行 xcode-select --install",
      );
    }
    log(`创建 Python 虚拟环境（Python ${python.version}）…`);
    const r = await runSpawn(python.cmd, [...python.args, "-m", "venv", p.venvDir], {
      env: pythonEnv(),
      timeoutMs: 240000,
    });
    if (r.code !== 0 || !fs.existsSync(p.venvPython)) {
      const detail = (r.stderr || r.stdout).trim().slice(-400) || `exit ${r.code}`;
      throw new Error(`创建 Python 虚拟环境失败：${detail}`);
    }
  }

  const requirements = path.join(p.coreDir, "requirements.txt");
  if (!fs.existsSync(requirements)) throw new Error("核心缺少 requirements.txt");
  log("安装核心依赖（bleak、Pillow）…");
  const r = await runSpawn(
    p.venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", requirements],
    { cwd: p.coreDir, env: pythonEnv(), timeoutMs: 10 * 60_000 },
  );
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(-500) || `exit ${r.code}`;
    throw new Error(`安装核心依赖失败：${detail}`);
  }
  log("Python 依赖已就绪");
}

export interface InstallCoreOptions {
  stateDir: string;
  sourceUrl: string;
  /** 可选下载加速前缀，例如 https://gh-proxy.com/。 */
  mirror?: string;
  /**
   * 测试用摘要覆盖：省略时按默认钉死来源自动校验；
   * 显式 null 表示跳过校验（仅单测注入假包时使用）。
   */
  expectedSha256?: string | null;
  onProgress?: (message: string) => void;
  downloader?: typeof download;
  extractor?: typeof extractArchive;
  python?: PythonRuntime | null;
  pythonFinder?: typeof findPython;
  /** 测试注入：替代真实的 venv 创建与依赖安装。 */
  venvEnsurer?: typeof ensureVenv;
  /** 测试注入：替代 `python -m todoocard_core --version` 自检。 */
  verifier?: (stateDir: string) => Promise<string>;
}

/** 下载通用核心、原子安装到 `<stateDir>/core`，再准备 venv 与依赖。 */
export async function installCore(opts: InstallCoreOptions): Promise<CoreMeta> {
  const log = opts.onProgress || (() => {});
  const p = statePaths(opts.stateDir);
  const downloader = opts.downloader || download;
  const extractor = opts.extractor || extractArchive;
  const directUrl = sourceToArchiveUrl(opts.sourceUrl);
  const archiveUrl = withDownloadMirror(directUrl, opts.mirror);
  const expectedSha256 = opts.expectedSha256 === undefined
    ? expectedSha256For(opts.sourceUrl)
    : opts.expectedSha256;
  fs.mkdirSync(p.tmpDir, { recursive: true });
  fs.mkdirSync(p.cacheDir, { recursive: true });
  const archive = path.join(p.tmpDir, isZipUrl(archiveUrl) ? "core.zip" : "core.tar.gz");
  const rawDir = path.join(p.tmpDir, "raw");
  const stageDir = path.join(p.tmpDir, "stage");
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });

  try {
    if (archiveUrl !== directUrl) log(`下载线路：第三方加速（原始地址 ${directUrl}）`);
    log(`下载核心：${archiveUrl}`);
    await downloader(archiveUrl, archive);
    const sha256 = sha256File(archive);
    log(`下载完成（${(fs.statSync(archive).size / 1024 / 1024).toFixed(2)} MB）`);
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(
        `下载内容 SHA-256 校验失败，已拒绝安装（期望 ${expectedSha256.slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…）`,
      );
    }
    log("解压并检查目录结构…");
    await extractor(archive, rawDir, isZipUrl(archiveUrl));
    const layout = normalizeCoreDir(rawDir, path.join(stageDir, "core"));
    log("原子替换旧核心…");
    atomicReplaceDir(path.join(stageDir, "core"), p.coreDir);
    const meta: CoreMeta = {
      sourceUrl: opts.sourceUrl.trim(),
      archiveUrl,
      ref: layout.ref,
      sha256,
      installedAt: Date.now(),
    };
    fs.writeFileSync(p.coreMetaFile, JSON.stringify(meta, null, 2), "utf8");

    await (opts.venvEnsurer || ensureVenv)({
      stateDir: opts.stateDir,
      onProgress: log,
      python: opts.python,
      pythonFinder: opts.pythonFinder,
    });
    const version = await (opts.verifier || verifyCoreModule)(opts.stateDir);
    log(`核心自检通过：${version || "todoocard_core"}`);
    log("核心安装完成");
    return meta;
  } finally {
    try { fs.unlinkSync(archive); } catch {}
    try { fs.rmSync(rawDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  }
}

export async function checkPrerequisites(stateDir?: string): Promise<PrereqView> {
  const errors: string[] = [];
  const python = await findPython();
  const platformSupported = ["darwin", "win32", "linux"].includes(process.platform);
  const venvReady = stateDir ? fs.existsSync(statePaths(stateDir).venvPython) : false;

  if (!python && !venvReady) {
    errors.push(
      process.platform === "win32"
        ? "未找到 Python 3.9+：请从 python.org 安装，并勾选 Add python.exe to PATH"
        : "未找到 Python 3.9+：请安装 Python 3；macOS 也可执行 xcode-select --install",
    );
  }
  if (!platformSupported) {
    errors.push(`当前系统 ${process.platform} 未在支持范围内（macOS / Windows）`);
  }
  return {
    checked: true,
    python: !!python,
    pythonVersion: python?.version || "",
    platformSupported,
    venvReady,
    errors,
  };
}
