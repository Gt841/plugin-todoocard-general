import fs from "fs";
import type { DeviceInfo, PluginState, SavedDevice, Settings } from "../types";
import { isDeviceId, normalizeDeviceId } from "./parse";
import { statePaths } from "./paths";

/**
 * 默认来源钉死到通用核心仓库的首个提交，并校验该提交 tarball 的 SHA-256。
 * 更新核心时改这两个常量（或让用户手动把来源改成新的 commit / main）。
 */
export const PINNED_COMMIT = "df8fe4fb734363f4826f94051e7d4f5e08002290";
export const DEFAULT_SOURCE_URL = PINNED_COMMIT
  ? `https://github.com/Gt841/plugin-todoocard-general-core/commit/${PINNED_COMMIT}`
  : "https://github.com/Gt841/plugin-todoocard-general-core";
export const PINNED_SHA256 = "326acecf56b7607620700af4211f8db92d0b736bc13393928aeec11695ff56e4";

export const DEFAULT_SETTINGS: Settings = {
  coreSourceUrl: DEFAULT_SOURCE_URL,
  downloadMirror: "",
  autoProbeAfterPair: true,
  rotateRight90: false,
};

export function defaultState(): PluginState {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, devices: {} };
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function normalizeSavedDevice(raw: any): SavedDevice | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !isDeviceId(raw.id)) return null;
  const id = normalizeDeviceId(raw.id) as string;
  return {
    id,
    name: str(raw.name),
    alias: str(raw.alias),
    compatible: bool(raw.compatible, false),
    firmware: numOrNull(raw.firmware),
    paired: bool(raw.paired, false),
    lastSeenAt: numOrNull(raw.lastSeenAt),
    lastPairedAt: numOrNull(raw.lastPairedAt),
    lastProbeAt: numOrNull(raw.lastProbeAt),
    lastSendAt: numOrNull(raw.lastSendAt),
  };
}

export function normalizeState(raw: any): PluginState {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const mirror = str(settings.downloadMirror, "").trim();
  base.settings = {
    coreSourceUrl: str(settings.coreSourceUrl || settings.sourceUrl, DEFAULT_SOURCE_URL).trim() || DEFAULT_SOURCE_URL,
    downloadMirror: !mirror || /^https?:\/\//i.test(mirror) ? mirror : "",
    autoProbeAfterPair: bool(settings.autoProbeAfterPair, true),
    rotateRight90: bool(settings.rotateRight90, false),
  };
  if (raw.devices && typeof raw.devices === "object") {
    for (const [key, value] of Object.entries(raw.devices)) {
      const rec = normalizeSavedDevice({ ...(value as any), id: (value as any)?.id || key });
      if (rec) base.devices[rec.id] = rec;
    }
  }
  return base;
}

/**
 * 同步范围之外的插件状态。写入采用「临时文件 + rename」，避免思源异常退出
 * 留下半截 JSON 导致下次启动读不到设备/配对信息。
 */
export class StateStore {
  readonly paths: ReturnType<typeof statePaths>;
  state: PluginState = defaultState();

  constructor(readonly dir: string) {
    this.paths = statePaths(dir);
  }

  load(): PluginState {
    try {
      const text = fs.readFileSync(this.paths.stateFile, "utf8");
      this.state = normalizeState(JSON.parse(text));
    } catch {
      this.state = defaultState();
    }
    return this.state;
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.paths.tmpDir, { recursive: true });
    fs.mkdirSync(this.paths.cacheDir, { recursive: true });
    fs.mkdirSync(this.paths.payloadDir, { recursive: true });
  }

  save(): void {
    this.ensureDir();
    const tmp = this.paths.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmp, this.paths.stateFile);
  }

  get settings(): Settings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.state.settings = { ...this.state.settings, ...patch };
    if (!this.state.settings.coreSourceUrl.trim()) this.state.settings.coreSourceUrl = DEFAULT_SOURCE_URL;
    this.state.settings.downloadMirror = (this.state.settings.downloadMirror || "").trim();
    this.save();
  }

  /** 把一次扫描到的设备并入记录；不会把扫描结果误当成「已配对」。 */
  mergeSeen(devices: DeviceInfo[]): void {
    const now = Date.now();
    for (const d of devices) {
      const prev = this.state.devices[d.id];
      this.state.devices[d.id] = {
        id: d.id,
        name: d.name || prev?.name || "",
        alias: prev?.alias || "",
        compatible: d.compatible,
        firmware: d.firmware ?? prev?.firmware ?? null,
        paired: prev?.paired ?? false,
        lastSeenAt: now,
        lastPairedAt: prev?.lastPairedAt ?? null,
        lastProbeAt: prev?.lastProbeAt ?? null,
        lastSendAt: prev?.lastSendAt ?? null,
      };
    }
    this.save();
  }

  record(id: string, patch: Partial<SavedDevice>): void {
    const normalizedId = normalizeDeviceId(id);
    if (!normalizedId) return;
    const prev = this.state.devices[normalizedId];
    this.state.devices[normalizedId] = {
      id: normalizedId,
      name: "", alias: "", compatible: false, firmware: null, paired: false,
      lastSeenAt: null, lastPairedAt: null, lastProbeAt: null, lastSendAt: null,
      ...prev,
      ...patch,
    };
    this.save();
  }

  setAlias(id: string, alias: string): void {
    this.record(id, { alias: alias.trim() });
  }

  remove(id: string): void {
    const normalizedId = normalizeDeviceId(id);
    if (!normalizedId) return;
    delete this.state.devices[normalizedId];
    this.save();
  }
}

export function displayName(rec: { alias?: string; name?: string; id: string }): string {
  return rec.alias || rec.name || rec.id.slice(0, 8);
}
