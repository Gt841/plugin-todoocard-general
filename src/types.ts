export const TODOCARD_MANUFACTURER = 0x5053;
export const TODOCARD_SCREEN_T3 = 0x134c;
export const PANEL_WIDTH = 528;
export const PANEL_HEIGHT = 792;

export interface DeviceInfo {
  id: string;
  name: string;
  rssi: number;
  services: string[];
  compatible: boolean;
  manufacturerId: number | null;
  screenType: number | null;
  /** 固件原始版本字节，例如 0xA7。 */
  firmware: number | null;
  secure: boolean;
  pairingOpen: boolean;
  recovery: boolean;
  turbo: boolean;
  lastSeenAt: number;
}

export interface SavedDevice {
  id: string;
  name: string;
  alias: string;
  compatible: boolean;
  firmware: number | null;
  paired: boolean;
  lastSeenAt: number | null;
  lastPairedAt: number | null;
  lastProbeAt: number | null;
  lastSendAt: number | null;
}

export interface Settings {
  /** 通用核心仓库地址（GitHub 仓库 / commit / 压缩包直链）。 */
  coreSourceUrl: string;
  /** 下载加速前缀，空字符串表示直连 GitHub。 */
  downloadMirror: string;
  autoProbeAfterPair: boolean;
  rotateRight90: boolean;
}

export interface PluginState {
  version: 1;
  settings: Settings;
  devices: Record<string, SavedDevice>;
}

export interface Filters {
  q: string;
  onlyCompatible: boolean;
  onlyPairing: boolean;
  onlyPaired: boolean;
  sort: "rssi" | "name";
}

export interface DeviceRow extends DeviceInfo {
  alias: string;
  paired: boolean;
  live: boolean;
  lastPairedAt: number | null;
  lastSendAt: number | null;
}

export interface CoreView {
  /**
   * 核心源码已安装。`ready` 还要求 Python 虚拟环境存在；只安装源码时用户在
   * 设置页仍能看到来源与摘要，但扫描/发送按钮会被拦下。
   */
  installed: boolean;
  ready: boolean;
  sourceUrl: string;
  archiveUrl: string;
  ref: string;
  sha256: string;
  installedAt: number;
  coreDir: string;
  venvDir: string;
  venvPython: string;
}

export interface PrereqView {
  checked: boolean;
  /** 找到可用的 Python 3.9+ 解释器。 */
  python: boolean;
  pythonVersion: string;
  platformSupported: boolean;
  /** 插件数据目录下已经有可执行的 venv Python。 */
  venvReady: boolean;
  errors: string[];
}

export type JobKind = "install" | "scan" | "pair" | "probe" | "bing" | "prepare" | "send";

export interface JobView {
  kind: JobKind | null;
  running: boolean;
  message: string;
  startedAt: number;
  canCancel: boolean;
}

export interface ImageView {
  path: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  dataUrl: string;
}

export type PreparedInputKind = "original" | "crop" | "layout";

export interface PreparedView {
  binBase64: string;
  width: number;
  height: number;
  bytes: number;
  legacyBytes: number;
  qlzBytes: number;
  at: number;
  inputName: string;
  /** 这份 payload 的输入来源：原图、2:3 取景裁剪图，或排版卡片。 */
  inputKind: PreparedInputKind;
}

export type ImageMode = "direct" | "layout";

export interface PanelView {
  stateDir: string;
  core: CoreView;
  prereq: PrereqView;
  /** 已拉起命令行工具安装器，正在等待并自动复查。 */
  envInstalling: boolean;
  devices: DeviceRow[];
  /** 全部已配对设备（不受设备页筛选影响），用于发送目标多选。 */
  pairedDevices: DeviceRow[];
  selected: DeviceRow | null;
  allDeviceCount: number;
  compatibleCount: number;
  selectedId: string | null;
  filters: Filters;
  scan: { running: boolean; secondsLeft: number };
  job: JobView;
  image: ImageView | null;
  /** 排版用的图片列表；直接发送时通常只有一张。 */
  images: ImageView[];
  /** 图片页当前模式；关闭面板再打开时保持一致。 */
  imageMode: ImageMode;
  /** 卡片版式；只有照片墙使用多图，关闭面板再打开时保持一致。 */
  cardLayout: "immersive" | "framed" | "wall";
  /** 下一次 Bing 壁纸的位置（0–7）；大于 0 时按钮显示「换一张壁纸」。 */
  bingIndex: number;
  prepared: PreparedView | null;
  log: string[];
  settings: Settings;
  platform: string;
}
