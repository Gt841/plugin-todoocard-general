import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import http from "http";
import { spawn } from "child_process";

export interface SpawnResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runSpawn(cmd: string, args: string[], opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    let child: any;
    try { child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true }); }
    catch (e) {
      resolve({ code: -1, signal: null, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * 不依赖 `/usr/bin/which`：Windows 上按 PATHEXT 扫描 PATH，macOS/Linux 直接按
 * 可执行位判断。返回绝对路径，后续 spawn 不再受 shell 别名影响。
 */
export function which(cmd: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const vars = env || process.env;
  const pathVar = vars.PATH || vars.Path || "";
  const exts = process.platform === "win32"
    ? (vars.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const hasExt = path.extname(cmd) !== "";
  const candidates = hasExt ? [""] : exts;
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of candidates) {
      const full = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(full).isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(full, fs.constants.X_OK);
        return Promise.resolve(full);
      } catch {}
    }
  }
  return Promise.resolve(null);
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function download(url: string, dest: string, timeoutMs = 180000, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error("too many redirects")); return; }
    const mod = url.startsWith("http://") ? http : https;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(); };
    const fail = (e: Error) => finish(() => {
      try { file.close(); } catch {}
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
    const succeed = () => finish(() => { try { file.close(() => resolve()); } catch { resolve(); } });
    file.on("error", fail);
    const req = mod.get(url, { headers: { "User-Agent": "siyuan-plugin-todoocard" } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        file.removeListener("error", fail);
        try { file.close(); } catch {}
        try { fs.unlinkSync(dest); } catch {}
        if (timer) clearTimeout(timer);
        download(res.headers.location, dest, timeoutMs, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); fail(new Error(`HTTP ${code}`)); return; }
      res.on("error", fail);
      res.pipe(file);
      file.on("finish", succeed);
    });
    req.on("error", fail);
    timer = setTimeout(() => { try { req.destroy(new Error("download timeout")); } catch {} }, timeoutMs);
  });
}

export function isZipUrl(url: string): boolean {
  return url.split("?")[0].split("#")[0].toLowerCase().endsWith(".zip");
}

export function extractCommand(archive: string, dest: string, isZip: boolean, platform = process.platform): { cmd: string; args: string[] } {
  if (isZip) {
    if (platform === "win32") {
      const a = archive.replace(/'/g, "''");
      const d = dest.replace(/'/g, "''");
      return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${a}' -DestinationPath '${d}' -Force`] };
    }
    return { cmd: "unzip", args: ["-o", archive, "-d", dest] };
  }
  return { cmd: "tar", args: ["-xzf", archive, "-C", dest] };
}

export async function extractArchive(archive: string, dest: string, isZip: boolean): Promise<void> {
  const { cmd, args } = extractCommand(archive, dest, isZip);
  const r = await runSpawn(cmd, args, { timeoutMs: 180000 });
  if (r.code !== 0) throw new Error(`解压失败（${cmd} exit ${r.code}）：${r.stderr.slice(-400)}`);
}

export function atomicReplaceDir(tmpDir: string, destDir: string): void {
  const backup = destDir + ".old";
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
  const hadDest = fs.existsSync(destDir);
  if (hadDest) fs.renameSync(destDir, backup);
  try {
    fs.renameSync(tmpDir, destDir);
  } catch (e) {
    if (hadDest) { try { fs.renameSync(backup, destDir); } catch {} }
    throw e;
  }
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
}
