import fs from "fs";
import path from "path";
import { StateStore, displayName } from "./store";
import { checkPrerequisites, detectCore, installCore } from "./core";
import { runSpawn } from "./fsutil";
import { CoreRunner } from "./runner";
import { classifyOutcome, parsePreparedPaths, parseScanLine, isDeviceId, type JobOutcome } from "./parse";
import { normalizeSendTargets, summarizeBatch, type SendTargetResult } from "./batch";
import { cleanupTempImages, isImageFile, previewDataUrl, readImageMeta, saveDroppedImage, savePastedPng, validateImageMeta } from "./image";
import { BING_MAX_INDEX, fetchBingWallpaper } from "./bing";
import { MAX_CARD_IMAGES, type CardLayout } from "./layout";
import { statePaths } from "./paths";
import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  type CoreView,
  type DeviceInfo,
  type DeviceRow,
  type Filters,
  type ImageMode,
  type ImageView,
  type JobKind,
  type PanelView,
  type PreparedInputKind,
  type PreparedView,
  type PrereqView,
} from "../types";

const TIMEOUTS: Record<string, number> = {
  list: 75_000,
  pair: 150_000,
  probe: 100_000,
  prepare: 180_000,
  send: 15 * 60_000,
};

export interface ServiceOptions {
  stateDir: string;
  onUpdate: () => void;
  notify?: (message: string, level?: "info" | "error") => void;
  platform?: string;
}

function nowLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export class TodooService {
  readonly store: StateStore;
  readonly stateDir: string;
  private readonly onUpdate: () => void;
  private readonly notify: (message: string, level?: "info" | "error") => void;
  private readonly platform: string;

  core: CoreView;
  prereq: PrereqView = {
    checked: false, python: false, pythonVersion: "", platformSupported: false, venvReady: false, errors: [],
  };
  live = new Map<string, DeviceInfo>();
  selectedId: string | null = null;
  filters: Filters = { q: "", onlyCompatible: true, onlyPairing: false, onlyPaired: false, sort: "rssi" };
  image: ImageView | null = null;
  images: ImageView[] = [];
  imageMode: ImageMode = "direct";
  /** 排版版式；关闭面板再打开会恢复，照片墙决定粘贴/拖入是追加还是替换。 */
  cardLayout: CardLayout = "immersive";
  /** 下一次获取 Bing 壁纸使用的归档位置，重复点击时在最近 8 天之间切换。 */
  bingIndex = 0;
  prepared: PreparedView | null = null;
  private preparedSource: string | null = null;
  job: { kind: JobKind | null; running: boolean; message: string; startedAt: number; canCancel: boolean } =
    { kind: null, running: false, message: "", startedAt: 0, canCancel: false };
  scan = { startedAt: 0, secondsLeft: 0 };
  logs: string[] = [];

  private runner: CoreRunner | null = null;
  private cancelRequested = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private envTimer: ReturnType<typeof setInterval> | null = null;
  private envDeadline = 0;
  private disposed = false;

  /** 已拉起系统命令行工具安装器，正在轮询复查。 */
  envInstalling = false;

  constructor(opts: ServiceOptions) {
    this.stateDir = opts.stateDir;
    this.onUpdate = opts.onUpdate;
    this.notify = opts.notify || (() => {});
    this.platform = opts.platform || process.platform;
    this.store = new StateStore(opts.stateDir);
    this.core = detectCore(opts.stateDir);
  }

  async init(): Promise<void> {
    this.store.load();
    this.store.ensureDir();
    this.core = detectCore(this.stateDir, this.store.settings.coreSourceUrl);
    this.preloadRunner();
    cleanupTempImages();
    this.log(`数据目录：${this.stateDir}`);
    this.log(this.core.installed
      ? `核心已${this.core.ready ? "就绪" : "安装，等待 Python 环境"}：${this.core.ref || this.core.archiveUrl || this.core.sourceUrl}`
      : "核心尚未安装，点击「下载核心」开始");
    const paired = Object.values(this.store.state.devices).find((d) => d.paired);
    this.selectedId = paired?.id || this.selectedId;
    this.prereq = await checkPrerequisites(this.stateDir);
    for (const err of this.prereq.errors) this.log(`环境检查：${err}`);
    this.push();
  }

  private preloadRunner() {
    const p = statePaths(this.stateDir);
    this.runner = this.core.ready ? new CoreRunner(p.venvPython, p.coreDir) : null;
  }

  dispose(): void {
    this.disposed = true;
    this.runner?.cancel();
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.stopEnvPoll();
  }

  private push() {
    if (this.disposed) return;
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (!this.disposed) this.onUpdate();
    }, 60);
  }

  private log(line: string) {
    this.logs.push(`[${nowLabel()}] ${line}`);
    if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
    this.push();
  }

  private clearLogs() {
    this.logs = [];
    this.push();
  }

  private begin(kind: JobKind, message: string, canCancel = true): CoreRunner | null {
    if (this.job.running) {
      this.notify("已有操作进行中，请先等待或取消", "info");
      return null;
    }
    const runner = this.core.ready
      ? new CoreRunner(this.core.venvPython, this.core.coreDir)
      : null;
    if (!runner?.canRun()) {
      this.notify("核心尚未就绪，请先下载核心并完成 Python 环境", "error");
      return null;
    }
    this.runner = runner;
    this.cancelRequested = false;
    this.job = { kind, running: true, message, startedAt: Date.now(), canCancel };
    this.log(`── ${message} ──`);
    this.push();
    return runner;
  }

  private finish(outcome: JobOutcome, opts: { toast?: boolean; prefix?: string } = {}) {
    const toast = opts.toast !== false;
    if (outcome.error) {
      this.log(`失败：${outcome.error}`);
      if (toast) this.notify(`${opts.prefix || ""}${outcome.error}`, "error");
    } else {
      this.log(`${opts.prefix || ""}${outcome.summary}`);
      if (toast) this.notify(`${opts.prefix || ""}${outcome.summary}`, "info");
    }
    this.job = { kind: null, running: false, message: "", startedAt: 0, canCancel: false };
    this.push();
  }

  getView(): PanelView {
    const rows: DeviceRow[] = [];
    const ids = new Set<string>([...this.live.keys(), ...Object.keys(this.store.state.devices)]);
    for (const id of ids) {
      const live = this.live.get(id);
      const rec = this.store.state.devices[id];
      const base: DeviceInfo = live || {
        id, name: rec?.name || "", rssi: -999, services: [], compatible: rec?.compatible ?? false,
        manufacturerId: null, screenType: null, firmware: rec?.firmware ?? null,
        secure: false, pairingOpen: false, recovery: false, turbo: false,
        lastSeenAt: rec?.lastSeenAt || 0,
      };
      rows.push({
        ...base,
        alias: rec?.alias || "",
        paired: rec?.paired ?? false,
        live: !!live,
        lastPairedAt: rec?.lastPairedAt ?? null,
        lastSendAt: rec?.lastSendAt ?? null,
      });
    }
    const f = this.filters;
    const q = f.q.trim().toLowerCase();
    const filtered = rows.filter((d) => {
      if (f.onlyCompatible && !d.compatible) return false;
      if (f.onlyPairing && !d.pairingOpen) return false;
      if (f.onlyPaired && !d.paired) return false;
      if (!q) return true;
      return [d.alias, d.name, d.id].some((v) => (v || "").toLowerCase().includes(q));
    });
    filtered.sort((a, b) => {
      if (f.sort === "name") return displayName(a).localeCompare(displayName(b), "zh-Hans-CN");
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.rssi - a.rssi;
    });
    const pairedDevices = rows
      .filter((d) => d.paired)
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        const recent = (b.lastSendAt || 0) - (a.lastSendAt || 0);
        return recent || displayName(a).localeCompare(displayName(b), "zh-Hans-CN");
      });
    return {
      stateDir: this.stateDir,
      core: this.core,
      prereq: this.prereq,
      envInstalling: this.envInstalling,
      devices: filtered,
      pairedDevices,
      selected: rows.find((d) => d.id === this.selectedId) || null,
      allDeviceCount: rows.length,
      compatibleCount: rows.filter((d) => d.compatible).length,
      selectedId: this.selectedId,
      filters: { ...f },
      scan: { running: this.job.kind === "scan" && this.job.running, secondsLeft: this.scan.secondsLeft },
      job: { ...this.job },
      image: this.image,
      images: this.images,
      imageMode: this.imageMode,
      cardLayout: this.cardLayout,
      bingIndex: this.bingIndex,
      prepared: this.prepared,
      log: this.logs.slice(-300),
      settings: { ...this.store.settings },
      platform: this.platform,
    };
  }

  // ── 核心安装 ──────────────────────────────────────────────────

  async install(manual = true): Promise<void> {
    if (this.job.running) {
      if (manual) this.notify("有操作进行中，请稍后再试", "info");
      return;
    }
    if (!(await this.ensureEnvironment(manual))) return;
    if (this.job.running) {
      if (manual) this.notify("有操作进行中，请稍后再试", "info");
      return;
    }
    this.job = { kind: "install", running: true, message: "正在下载通用核心并准备 Python 环境…", startedAt: Date.now(), canCancel: false };
    this.log("── 下载通用核心（plugin-todoocard-general-core）──");
    this.push();
    try {
      const source = this.store.settings.coreSourceUrl;
      const mirror = this.store.settings.downloadMirror;
      const meta = await installCore({
        stateDir: this.stateDir,
        sourceUrl: source,
        mirror,
        onProgress: (m) => this.log(m),
      });
      this.core = detectCore(this.stateDir, source);
      this.preloadRunner();
      this.store.updateSettings({ coreSourceUrl: source });
      this.prereq = await checkPrerequisites(this.stateDir);
      this.log(`核心已安装：${meta.ref || meta.archiveUrl}（${meta.sha256.slice(0, 10)}…）`);
      if (manual) this.notify("通用核心已就绪", "info");
    } catch (e) {
      this.log(`安装失败：${String(e)}`);
      this.notify(`核心安装失败：${String(e)}`, "error");
    } finally {
      this.job = { kind: null, running: false, message: "", startedAt: 0, canCancel: false };
      this.push();
    }
  }

  /** 首次安装核心前的硬门槛：环境必须检查过且没有错误。 */
  private async ensureEnvironment(manual: boolean): Promise<boolean> {
    if (!this.prereq.checked) this.prereq = await checkPrerequisites(this.stateDir);
    if (!this.prereq.errors.length) return true;
    this.log("安装核心已阻止：运行环境未就绪");
    for (const err of this.prereq.errors) this.log(`环境检查：${err}`);
    if (manual) this.notify("请先完成运行环境检查与安装，再下载核心", "error");
    this.push();
    return false;
  }

  async recheckPrereq(): Promise<void> {
    this.prereq = await checkPrerequisites(this.stateDir);
    this.envInstalling = false;
    this.stopEnvPoll();
    this.core = detectCore(this.stateDir, this.store.settings.coreSourceUrl);
    this.preloadRunner();
    this.log(this.prereq.errors.length ? `环境检查：${this.prereq.errors.join("；")}` : "环境检查通过");
    this.push();
  }

  /**
   * 引导安装 Python：
   * - macOS：Xcode Command Line Tools 自带 python3，仍可一键拉起系统安装器；
   * - Windows：打开 python.org 下载页，用户需勾选 Add python.exe to PATH。
   * 拉起后每 4 秒自动复查，最多等待 10 分钟。
   */
  async installEnvironment(): Promise<void> {
    if (this.envInstalling) return;
    this.envInstalling = true;
    this.push();
    if (!this.prereq.checked) this.prereq = await checkPrerequisites(this.stateDir);
    if (!this.prereq.errors.length) {
      this.envInstalling = false;
      this.notify("运行环境已就绪", "info");
      this.push();
      return;
    }

    let shouldPoll = true;
    if (this.platform === "darwin") {
      this.log("── 安装运行环境（Xcode Command Line Tools）──");
      this.log("如弹出 macOS 安装窗口，请点击「安装」并等待完成；插件会自动复查。");
      this.push();
      try {
        const r = await runSpawn("/usr/bin/xcode-select", ["--install"], { timeoutMs: 20_000 });
        const output = [r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
        if (output) this.log(output);
        if (r.timedOut) {
          this.log("安装器未在 20 秒内返回；如果系统窗口已打开，请继续完成安装。");
        } else if (r.code !== 0) {
          if (/already installed/i.test(output)) {
            this.log("Command Line Tools 已安装但仍未找到 python3，可改从 python.org 安装 Python 3。");
          } else {
            shouldPoll = false;
            this.log("未能自动拉起安装器；可手动在终端执行：xcode-select --install");
          }
        }
      } catch (e) {
        shouldPoll = false;
        this.log(`拉起安装器失败：${String(e)}`);
      }
    } else if (this.platform === "win32") {
      this.log("── 安装运行环境（Python 3）──");
      this.log("已打开 python.org 下载页：安装时务必勾选 Add python.exe to PATH。");
      this.push();
      try {
        await runSpawn("cmd", ["/c", "start", "", "https://www.python.org/downloads/windows/"], { timeoutMs: 15_000 });
      } catch (e) {
        shouldPoll = false;
        this.log(`打开下载页失败：${String(e)}`);
        this.log("请手动访问 https://www.python.org/downloads/windows/ 安装 Python 3.9+。");
      }
    } else {
      shouldPoll = false;
      this.log(`当前系统 ${this.platform} 暂不支持一键安装 Python，请先手动安装 Python 3.9+。`);
    }

    if (!shouldPoll) {
      this.envInstalling = false;
      this.log("完成手动安装后，点「重新检查」更新状态");
      this.push();
      return;
    }
    this.envDeadline = Date.now() + 10 * 60_000;
    this.startEnvPoll();
    this.push();
  }

  private startEnvPoll() {
    this.stopEnvPoll();
    this.envTimer = setInterval(() => { void this.pollEnvironment(); }, 4_000);
  }

  private stopEnvPoll() {
    if (this.envTimer) clearInterval(this.envTimer);
    this.envTimer = null;
  }

  private async pollEnvironment() {
    if (this.disposed) return;
    const prereq = await checkPrerequisites(this.stateDir);
    if (this.disposed) return;
    this.prereq = prereq;
    if (!prereq.errors.length) {
      this.envInstalling = false;
      this.stopEnvPoll();
      this.core = detectCore(this.stateDir, this.store.settings.coreSourceUrl);
      this.preloadRunner();
      this.log("环境检查通过，可以安装核心了");
      this.notify("运行环境已就绪", "info");
    } else if (Date.now() >= this.envDeadline) {
      this.envInstalling = false;
      this.stopEnvPoll();
      this.log("等待环境安装超时；完成系统安装后点「重新检查」");
    }
    this.push();
  }

  // ── 扫描 / 设备 ──────────────────────────────────────────────

  async scanDevices(): Promise<void> {
    const runner = this.begin("scan", "正在搜索附近设备…");
    if (!runner) return;
    this.live.clear();
    this.scan = { startedAt: Date.now(), secondsLeft: 0 };
    this.startCountdown();
    const result = await runner.run(["--list"], {
      timeoutMs: TIMEOUTS.list,
      onLine: (line, stream) => {
        this.log(stream === "stderr" ? `stderr: ${line}` : line);
        const device = parseScanLine(line);
        if (device) {
          this.live.set(device.id, device);
          this.job.message = `已发现 ${this.live.size} 台设备…`;
          this.push();
        }
        if (line.includes("Scanning nearby BLE devices for 30s")) {
          this.scan = { startedAt: Date.now(), secondsLeft: 30 };
        }
      },
    });
    this.stopCountdown();
    const outcome = classifyOutcome("scan", result.lines, result.code, result.signal);
    if (result.canceled) outcome.summary = "扫描已取消";
    else if (result.timedOut) { outcome.ok = false; outcome.error = "扫描超时"; }
    this.store.mergeSeen([...this.live.values()]);
    if (!this.selectedId) {
      const first = [...this.live.values()].find((d) => d.compatible) || [...this.live.values()][0];
      if (first) this.selectedId = first.id;
    }
    this.finish(outcome, { toast: false });
    this.log(`本次发现 ${this.live.size} 台设备`);
  }

  cancelJob(): void {
    if (!this.job.running) return;
    if (!this.job.canCancel) { this.notify("当前任务不可取消", "info"); return; }
    this.cancelRequested = true;
    this.log("正在取消当前操作…");
    this.runner?.cancel();
  }

  private startCountdown() {
    this.stopCountdown();
    this.scanTimer = setInterval(() => {
      if (this.scan.secondsLeft > 0) {
        this.scan.secondsLeft = Math.max(0, this.scan.secondsLeft - 1);
        this.push();
      }
    }, 1000);
  }

  private stopCountdown() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.scan.secondsLeft = 0;
    this.push();
  }

  selectDevice(id: string | null): void {
    this.selectedId = id;
    this.push();
  }

  setFilters(patch: Partial<Filters>): void {
    this.filters = { ...this.filters, ...patch };
    this.push();
  }

  setAlias(id: string, alias: string): void {
    if (!isDeviceId(id)) return;
    this.store.setAlias(id, alias);
    this.log(`设备备注已更新：${alias || "(空)"}`);
    this.push();
  }

  forgetDevice(id: string): void {
    this.store.remove(id);
    if (this.selectedId === id) this.selectedId = null;
    this.log("已移除设备记录（不会解除系统蓝牙配对）");
    this.push();
  }

  // ── 配对 / 探测 ──────────────────────────────────────────────

  async pair(id = this.selectedId): Promise<void> {
    if (!id || !isDeviceId(id)) { this.notify("请先选择一台设备", "error"); return; }
    const device = this.live.get(id);
    if (device?.recovery) { this.notify("设备处于 OTA 恢复模式，拒绝传图/配对，请先修复固件", "error"); return; }
    const runner = this.begin("pair", "等待卡片进入配对窗口…");
    if (!runner) return;
    const result = await runner.run(["--pair", "--device-id", id], {
      timeoutMs: TIMEOUTS.pair,
      onLine: (line, stream) => {
        this.log(stream === "stderr" ? `stderr: ${line}` : line);
        if (line.includes("Physical pairing window detected")) this.job.message = "检测到配对窗口，正在建立系统绑定…";
        if (line.includes("Hold the rear button")) this.job.message = "请长按卡片背面按钮 5 秒，直到正面灯快闪…";
        this.push();
      },
    });
    const outcome = classifyOutcome("pair", result.lines, result.code, result.signal);
    if (result.canceled) { outcome.ok = false; outcome.error = "配对已取消"; }
    if (outcome.ok) {
      this.store.record(id, {
        paired: true,
        name: device?.name || "",
        compatible: device?.compatible ?? true,
        firmware: device?.firmware ?? null,
        lastPairedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      this.selectedId = id;
      if (this.store.settings.autoProbeAfterPair) {
        this.job.message = "配对成功，正在验证设备…";
        this.log(`${outcome.summary}，自动执行一次探测验证…`);
        this.push();
        const probeOutcome = await this.probeInternal(runner, id);
        if (probeOutcome.ok) {
          this.finish({ ...outcome, summary: `${outcome.summary}；${probeOutcome.summary}` });
          return;
        }
        // 之前这里把配对结果当成探测结果展示，用户只看到「配对成功」而看不到
        // 探测失败的真实原因；现在明确报告探测侧的错误。
        this.finish(
          {
            ok: false,
            summary: "探测失败",
            error: probeOutcome.error || probeOutcome.summary || "未收到探测成功确认",
          },
          { toast: true, prefix: "配对成功，但探测未通过：" },
        );
        return;
      }
      this.finish(outcome);
      return;
    }
    this.finish(outcome);
  }

  async probe(id = this.selectedId): Promise<void> {
    if (!id || !isDeviceId(id)) { this.notify("请先选择一台设备", "error"); return; }
    const runner = this.begin("probe", "正在探测设备并验证加密连接…");
    if (!runner) return;
    const outcome = await this.probeInternal(runner, id);
    this.finish(outcome);
  }

  private async probeInternal(runner: CoreRunner, id: string): Promise<JobOutcome> {
    const result = await runner.run(["--probe", "--device-id", id], {
      timeoutMs: TIMEOUTS.probe,
      onLine: (line, stream) => {
        this.log(stream === "stderr" ? `stderr: ${line}` : line);
        if (line.includes("Encrypted link verified")) this.job.message = "加密连接已验证，读取设备信息…";
        this.push();
      },
    });
    const outcome = classifyOutcome("probe", result.lines, result.code, result.signal);
    if (outcome.ok) {
      const live = this.live.get(id);
      this.store.record(id, {
        paired: true,
        name: live?.name || this.store.state.devices[id]?.name || "",
        compatible: live?.compatible ?? this.store.state.devices[id]?.compatible ?? true,
        firmware: live?.firmware ?? this.store.state.devices[id]?.firmware ?? null,
        lastProbeAt: Date.now(),
      });
      this.selectedId = id;
    }
    this.push();
    return outcome;
  }

  // ── 图片 ─────────────────────────────────────────────────────

  private async readImageView(file: string): Promise<ImageView> {
    if (!isImageFile(file)) throw new Error("请选择 JPG/PNG/HEIC 等图片文件");
    if (!fs.existsSync(file)) throw new Error("图片不存在或已被移动");
    const meta = await readImageMeta(file);
    validateImageMeta(meta);
    const dataUrl = await previewDataUrl(file, statePaths(this.stateDir).cacheDir);
    return {
      path: file,
      name: path.basename(file),
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      dataUrl,
    };
  }

  /** 直接发送使用单图：替换当前图片列表。 */
  async setImage(file: string): Promise<void> {
    await this.addImages([file], { replace: true });
  }

  /**
   * 排版图片列表。单图版式只取第一张，照片墙最多 6 张；重复路径不会重复加入。
   * 读取失败的单张会被跳过，不影响其它已成功的图片。
   */
  async addImages(files: string[], opts: { replace?: boolean } = {}): Promise<number> {
    const unique = [...new Set(files.filter((file) => typeof file === "string" && file.trim()))];
    if (!unique.length) return 0;
    const selected = unique.slice(0, MAX_CARD_IMAGES);
    const loaded: ImageView[] = [];
    const errors: string[] = [];
    for (const file of selected) {
      try {
        loaded.push(await this.readImageView(file));
      } catch (e) {
        errors.push(`${path.basename(file)}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!loaded.length) {
      const message = errors[0] || "没有可用的图片";
      this.log(`图片读取失败：${message}`);
      this.notify(message, "error");
      this.push();
      return 0;
    }

    const base = opts.replace ? [] : this.images;
    const seen = new Set(base.map((item) => item.path));
    const merged = [...base];
    for (const item of loaded) {
      if (seen.has(item.path)) continue;
      merged.push(item);
      seen.add(item.path);
    }
    const overflow = merged.length > MAX_CARD_IMAGES;
    const beforeCount = base.length;
    this.images = merged.slice(0, MAX_CARD_IMAGES);
    this.image = this.images[0] || null;
    const addedCount = this.images.length - beforeCount;
    this.clearPreparedState();
    if (opts.replace) {
      const first = this.images[0];
      if (first) this.log(`已选择图片：${first.name}（${first.width}×${first.height}）`);
    } else {
      this.log(`已添加 ${loaded.length} 张图片，共 ${this.images.length} 张`);
    }
    if (errors.length) {
      this.log(`跳过图片：${errors.join("；")}`);
      this.notify(errors[0], "error");
    }
    if (overflow) this.notify(`照片墙最多 ${MAX_CARD_IMAGES} 张，多出的图片未加入`, "info");
    this.push();
    return addedCount;
  }

  async setPastedPng(png: Buffer, append = false): Promise<void> {
    if (!png.length) { this.notify("剪贴板里没有图片", "error"); return; }
    const file = savePastedPng(png);
    if (append) {
      const added = await this.addImages([file]);
      if (added) this.log("已从剪贴板粘贴截图");
      return;
    }
    await this.setImage(file);
    if (this.image) this.log("已从剪贴板粘贴截图");
  }

  async setDroppedImage(bytes: Buffer, name: string, append = false): Promise<void> {
    if (!bytes.length) { this.notify("拖入的文件为空", "error"); return; }
    const file = saveDroppedImage(bytes, name || "image.png");
    if (append) await this.addImages([file]);
    else await this.setImage(file);
  }

  async addDroppedImages(files: { bytes: Buffer; name: string }[], append = true): Promise<void> {
    const paths: string[] = [];
    for (const file of files) {
      if (!file.bytes?.length) continue;
      paths.push(saveDroppedImage(file.bytes, file.name || "image.png"));
    }
    if (!paths.length) { this.notify("拖入的文件为空", "error"); return; }
    if (append) await this.addImages(paths);
    else await this.setImage(paths[0]);
  }

  removeImage(file: string): void {
    const next = this.images.filter((item) => item.path !== file);
    if (next.length === this.images.length) return;
    this.images = next;
    this.image = next[0] || null;
    this.clearPreparedState();
    this.log(`已移除图片，剩余 ${next.length} 张`);
    this.push();
  }

  moveImage(file: string, delta: number): void {
    const index = this.images.findIndex((item) => item.path === file);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.images.length || !delta) return;
    const next = [...this.images];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    this.images = next;
    this.image = next[0] || null;
    this.clearPreparedState();
    this.push();
  }

  async loadBingWallpaper(append = true): Promise<void> {
    if (this.job.running) { this.notify("有操作进行中，请稍后再试", "info"); return; }
    if (append && this.images.length >= MAX_CARD_IMAGES) {
      this.notify(`照片墙最多 ${MAX_CARD_IMAGES} 张，请先移除一张`, "info");
      return;
    }
    this.job = { kind: "bing", running: true, message: "正在获取 Bing 每日壁纸…", startedAt: Date.now(), canCancel: false };
    this.log("── 获取 Bing 每日壁纸 ──");
    this.push();
    try {
      const index = this.bingIndex;
      const result = await fetchBingWallpaper({ cacheDir: this.store.paths.cacheDir, index });
      const added = await this.addImages([result.path], { replace: !append });
      if (added) {
        const credit = result.meta.copyright ? ` · ${result.meta.copyright}` : "";
        this.log(`Bing 壁纸：${result.meta.title}${credit}${result.stale ? "（本地缓存）" : ""}`);
        this.notify(result.stale ? "网络不可用，已使用本地缓存的 Bing 壁纸" : "已获取 Bing 每日壁纸", "info");
      } else {
        this.notify("这张 Bing 壁纸已在图片列表中", "info");
      }
      // 每次成功获取后换到下一张，重复点击即可切换最近 8 天的壁纸。
      this.bingIndex = (index + 1) % (BING_MAX_INDEX + 1);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`Bing 壁纸失败：${message}`);
      this.notify(message, "error");
    } finally {
      this.job = { kind: null, running: false, message: "", startedAt: 0, canCancel: false };
      this.push();
    }
  }

  clearImage(): void {
    this.image = null;
    this.images = [];
    this.clearPreparedState();
    this.push();
  }

  setRotate(value: boolean): void {
    this.store.updateSettings({ rotateRight90: value });
    this.clearPreparedState();
    this.push();
  }

  /** 图片页模式由面板驱动；主进程需要靠它决定粘贴/拖入是替换还是追加。 */
  setImageMode(mode: ImageMode): void {
    this.imageMode = mode;
  }

  /** 只有照片墙追加图片，其它版式始终单图替换。 */
  get cardWall(): boolean {
    return this.cardLayout === "wall";
  }

  /** 版式由面板驱动；面板重建时按它恢复当前排版。 */
  setCardLayout(layout: CardLayout): void {
    this.cardLayout = layout;
  }

  /** 裁剪构图变化后，旧的 payload 已经不再对应当前画面。 */
  invalidatePrepared(): void {
    this.clearPreparedState();
    this.push();
  }

  private clearPreparedState(): void {
    this.prepared = null;
    this.preparedSource = null;
  }

  // ── 生成 / 发送 ──────────────────────────────────────────────

  async prepare(
    croppedPng: Buffer | null = null,
    croppedName = "crop.png",
    kind: "crop" | "layout" = "crop",
  ): Promise<void> {
    if (!this.image) { this.notify("请先选择或粘贴一张图片", "error"); return; }
    if (kind === "layout" && !croppedPng?.length) {
      this.notify("排版卡片尚未生成", "error");
      return;
    }
    const runner = this.begin("prepare", "正在转换六色 payload 并校验…");
    if (!runner) return;
    let inputPath = this.image.path;
    const inputKind: PreparedInputKind = croppedPng?.length ? kind : "original";
    const inputName = croppedPng?.length ? (croppedName || "crop.png") : this.image.name;
    if (croppedPng?.length) {
      try {
        inputPath = saveDroppedImage(croppedPng, croppedName || "crop.png");
      } catch (e) {
        this.finish({
          ok: false,
          summary: "预览失败",
          error: `无法保存${kind === "layout" ? "卡片图" : "裁剪图"}：${String(e)}`,
        });
        return;
      }
    }
    this.clearPreparedState();
    const args = ["--input", inputPath, "--output", this.store.paths.payloadDir];
    // 裁剪图/排版图里的旋转已经烘焙进像素，不能再让核心转一次。
    if (inputKind === "original" && this.store.settings.rotateRight90) args.push("--rotate-right-90");
    const result = await runner.run(args, {
      timeoutMs: TIMEOUTS.prepare,
      onLine: (line, stream) => {
        this.log(stream === "stderr" ? `stderr: ${line}` : line);
        if (line.startsWith("Color mode:")) this.job.message = "正在进行六色抖动与面板校准…";
        if (line.startsWith("Prepared v157+")) this.job.message = "payload 校验通过";
        this.push();
      },
    });
    const outcome = classifyOutcome("prepare", result.lines, result.code, result.signal);
    if (result.canceled) { outcome.ok = false; outcome.error = "已取消"; }
    if (outcome.ok) {
      const paths = parsePreparedPaths(result.lines);
      if (paths.binPath && fs.existsSync(paths.binPath)) {
        const buf = fs.readFileSync(paths.binPath);
        const expected = (PANEL_WIDTH * PANEL_HEIGHT) / 2;
        if (buf.length !== expected) {
          this.finish({ ok: false, summary: "预览失败", error: `payload 尺寸异常：${buf.length}，期望 ${expected}` });
          return;
        }
        this.prepared = {
          binBase64: buf.toString("base64"),
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
          bytes: buf.length,
          legacyBytes: paths.legacyBytes || 0,
          qlzBytes: paths.qlzPath && fs.existsSync(paths.qlzPath) ? fs.statSync(paths.qlzPath).size : 0,
          at: Date.now(),
          inputName,
          inputKind,
        };
        this.preparedSource = inputPath;
      } else {
        this.finish({ ok: false, summary: "预览失败", error: "未找到生成的 payload 文件" });
        return;
      }
    }
    this.finish(outcome);
  }

  async send(targetIds?: string[]): Promise<void> {
    if (!this.image) { this.notify("请先选择或粘贴一张图片", "error"); return; }
    if (!this.prepared || !this.preparedSource) { this.notify("请先生成并校验预览，再发送", "error"); return; }
    const pairedIds = Object.values(this.store.state.devices)
      .filter((d) => d.paired)
      .map((d) => d.id);
    const targets = normalizeSendTargets(targetIds, pairedIds, this.selectedId);
    if (!targets.length) { this.notify("请至少选择一台已配对的卡片", "error"); return; }

    const nameOf = (id: string) =>
      displayName(this.store.state.devices[id] || this.live.get(id) || { id });
    const multi = targets.length > 1;
    const runner = this.begin(
      "send",
      multi ? `正在发送到 ${targets.length} 台卡片…` : `正在发送到 ${nameOf(targets[0])}…`,
    );
    if (!runner) return;

    const results: SendTargetResult[] = [];
    let canceled = false;

    for (let i = 0; i < targets.length; i++) {
      if (this.cancelRequested) { canceled = true; break; }
      const id = targets[i];
      const name = nameOf(id);
      const tag = multi ? `${i + 1}/${targets.length} · ${name}` : name;
      if (!isDeviceId(id)) {
        results.push({ id, name, ok: false, error: "设备 ID 无效" });
        this.log(`跳过 ${name}：设备 ID 无效`);
        continue;
      }
      const device = this.live.get(id);
      if (device?.recovery) {
        results.push({ id, name, ok: false, error: "设备处于 OTA 恢复模式，拒绝传图" });
        this.log(`跳过 ${name}：设备处于 OTA 恢复模式`);
        continue;
      }

      this.job.message = `正在发送到 ${tag}…`;
      this.log(`── 发送到 ${name}（${id}）──`);
      this.push();

      const args = ["--input", this.preparedSource, "--device-id", id, "--send"];
      if (this.store.settings.rotateRight90 && this.prepared.inputKind === "original") args.push("--rotate-right-90");
      const result = await runner.run(args, {
        timeoutMs: TIMEOUTS.send,
        onLine: (line, stream) => {
          this.log(multi ? `[${tag}] ${stream === "stderr" ? `stderr: ${line}` : line}` : (stream === "stderr" ? `stderr: ${line}` : line));
          const progress = line.match(/^Progress: (\d+)% block=(\d+)/);
          if (progress) this.job.message = `${tag} 发送中 ${progress[1]}%（块 ${progress[2]}）`;
          else if (line.startsWith("Connecting")) this.job.message = `正在连接 ${tag}…`;
          else if (line.startsWith("Control notification enabled")) this.job.message = `${tag} 已连接，开始传输…`;
          else if (line.includes("waiting for refresh")) this.job.message = `等待 ${tag} 显影确认…`;
          this.push();
        },
      });
      const outcome = classifyOutcome("send", result.lines, result.code, result.signal);
      if (result.canceled) {
        canceled = true;
        results.push({ id, name, ok: false, error: "已取消" });
        break;
      }
      if (outcome.ok) {
        results.push({ id, name, ok: true });
        this.store.record(id, {
          lastSendAt: Date.now(),
          paired: true,
          name: device?.name || this.store.state.devices[id]?.name || "",
        });
      } else {
        results.push({ id, name, ok: false, error: outcome.error || outcome.summary || "发送失败" });
      }
      this.push();
    }

    const sent = results.filter((r) => r.ok).length;
    if (canceled) {
      this.finish({
        ok: false,
        summary: `已取消（完成 ${sent}/${targets.length} 台）`,
        error: "发送已取消（卡片可能只收到部分数据）",
      });
      return;
    }
    const agg = summarizeBatch(results);
    if (agg.failed > 0) this.log(agg.summary);
    this.finish({ ok: agg.ok, summary: agg.summary, error: agg.error });
  }

  // ── 设置 / 工具 ──────────────────────────────────────────────

  updateSettings(patch: { coreSourceUrl?: string; sourceUrl?: string; downloadMirror?: string; autoProbeAfterPair?: boolean }): void {
    const clean: Record<string, unknown> = {};
    const source = patch.coreSourceUrl ?? patch.sourceUrl;
    if (typeof source === "string" && source.trim()) clean.coreSourceUrl = source.trim();
    if (typeof patch.downloadMirror === "string") {
      const mirror = patch.downloadMirror.trim();
      clean.downloadMirror = !mirror || /^https?:\/\//i.test(mirror) ? mirror : "";
    }
    if (typeof patch.autoProbeAfterPair === "boolean") clean.autoProbeAfterPair = patch.autoProbeAfterPair;
    this.store.updateSettings(clean);
    this.core = detectCore(this.stateDir, this.store.settings.coreSourceUrl);
    this.log("设置已保存（存储在同步范围之外）");
    this.push();
  }

  clearLog(): void {
    this.clearLogs();
  }
}
