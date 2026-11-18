import path from "path";
import os from "os";

/**
 * 插件数据（通用核心副本、Python 虚拟环境、设备别名、配对状态、上次选择）
 * 必须放在思源的同步范围之外。
 *
 * 默认位置是工作区根下的 `todoocard-general/`（`data/` 的上一级）。思源同步只
 * 覆盖 `data/`，因此核心文件与配对信息不会被云端旧副本覆盖。macOS 与 Windows
 * 都遵循同一规则，找不到工作区目录时才退回用户主目录。
 */
export const STATE_DIR_NAME = "todoocard-general";

export function resolveStateDir(opts: {
  dataDir?: string;
  userData?: string;
  home?: string;
  platform?: string;
} = {}): string {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const candidates: string[] = [];

  if (opts.dataDir) {
    const dataDir = path.resolve(opts.dataDir);
    if (path.basename(dataDir) === "data") {
      candidates.push(path.join(path.dirname(dataDir), STATE_DIR_NAME));
    }
  }
  if (opts.userData) {
    const userData = path.resolve(opts.userData);
    const root = path.basename(userData) === "SiYuan-Electron"
      ? path.join(path.dirname(userData), "SiYuan")
      : userData;
    candidates.push(path.join(root, STATE_DIR_NAME));
  }
  if (platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "SiYuan", STATE_DIR_NAME));
  }
  if (platform === "win32" && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "SiYuan", STATE_DIR_NAME));
  }
  candidates.push(path.join(home, `.siyuan-${STATE_DIR_NAME}`));

  return candidates[0] || path.join(home, `.siyuan-${STATE_DIR_NAME}`);
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 虚拟环境里的 Python 可执行文件；只依赖平台，不依赖是否已创建。 */
export function venvPythonPath(venvDir: string, platform: string = process.platform): string {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/** 插件下载的独立 Python 运行时里的解释器（不依赖系统 Python）。 */
export function runtimePythonPath(runtimeDir: string, platform: string = process.platform): string {
  return platform === "win32"
    ? path.join(runtimeDir, "python.exe")
    : path.join(runtimeDir, "bin", "python3");
}

export function statePaths(stateDir: string, platform: string = process.platform) {
  const coreDir = path.join(stateDir, "core");
  const venvDir = path.join(stateDir, "venv");
  const pythonRuntimeDir = path.join(stateDir, "python");
  return {
    dir: stateDir,
    stateFile: path.join(stateDir, "state.json"),
    coreDir,
    coreMetaFile: path.join(stateDir, "core-meta.json"),
    pythonRuntimeDir,
    pythonRuntimePython: runtimePythonPath(pythonRuntimeDir, platform),
    pythonRuntimeMetaFile: path.join(stateDir, "python-meta.json"),
    venvDir,
    venvPython: venvPythonPath(venvDir, platform),
    payloadDir: path.join(stateDir, "cache", "payloads"),
    tmpDir: path.join(stateDir, "tmp"),
    cacheDir: path.join(stateDir, "cache"),
  };
}

/** 应用退出后仍可能残留的临时图片目录。 */
export function tempImageDir(): string {
  return path.join(os.tmpdir(), "siyuan-todoocard-general");
}
