import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";

export interface RunOptions {
  timeoutMs: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onStart?: (pid: number) => void;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  lines: string[];
  canceled: boolean;
  timedOut: boolean;
}

function pythonEnv(): NodeJS.ProcessEnv {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  return {
    ...process.env,
    [pathKey]: process.env[pathKey] || process.env.PATH || "",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

/**
 * 通用核心是普通的 Python 命令行程序，不再每次编译 Swift。这里直接运行
 * `<stateDir>/venv` 里的解释器，并以独立进程组启动，便于取消时连同 Python
 * 子进程一起终止。
 */
export class CoreRunner {
  private child: ChildProcess | null = null;
  private canceled = false;
  private timedOut = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private pythonPath: string, private coreDir: string) {}

  get running(): boolean {
    return !!this.child;
  }

  get cliPath(): string {
    return path.join(this.coreDir, "todoocard_core", "cli.py");
  }

  canRun(): boolean {
    return fs.existsSync(this.pythonPath) && fs.existsSync(this.cliPath);
  }

  async run(args: string[], opts: RunOptions): Promise<RunResult> {
    if (this.child) throw new Error("已有操作进行中");
    this.canceled = false;
    this.timedOut = false;
    const lines: string[] = [];
    const child = spawn(this.pythonPath, ["-m", "todoocard_core", ...args], {
      cwd: this.coreDir,
      env: pythonEnv(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid) opts.onStart?.(child.pid);

    const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const emit = (line: string, stream: "stdout" | "stderr") => {
      lines.push(line);
      try { opts.onLine?.(line, stream); } catch {}
    };
    const handle = (chunk: Buffer, stream: "stdout" | "stderr") => {
      buffers[stream] += chunk.toString("utf8");
      const parts = buffers[stream].split(/\r?\n/);
      buffers[stream] = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (line) emit(line, stream);
      }
    };
    const flush = () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const line = buffers[stream].trimEnd();
        buffers[stream] = "";
        if (line) emit(line, stream);
      }
    };
    child.stdout?.on("data", (d: Buffer) => handle(d, "stdout"));
    child.stderr?.on("data", (d: Buffer) => handle(d, "stderr"));

    return await new Promise<RunResult>((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        flush();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.child = null;
        resolve({ code, signal, lines, canceled: this.canceled, timedOut: this.timedOut });
      };
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.killGroup();
      }, opts.timeoutMs);
      child.on("error", (e) => {
        lines.push(`spawn error: ${e.message}`);
        finish(-1, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  cancel(): void {
    this.canceled = true;
    this.killGroup();
    const pid = this.child?.pid;
    setTimeout(() => {
      if (this.child && this.child.pid === pid) this.killGroup(true);
    }, 1500);
  }

  private killGroup(force = false): void {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const args = ["/PID", String(child.pid), "/T"];
      if (force) args.push("/F");
      try {
        const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { try { child.kill(); } catch {} });
      } catch {
        try { child.kill(); } catch {}
      }
      return;
    }
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
  }
}
