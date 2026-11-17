import {
  TODOCARD_MANUFACTURER,
  TODOCARD_SCREEN_T3,
  type DeviceInfo,
} from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
const LEGACY_RE = /^[0-9a-f]{12,16}$/i;

/**
 * 通用核心在 macOS 返回 CoreBluetooth UUID，在 Windows/Linux 返回 MAC，蓝色
 * 牙旧接口也可能给出裸十六进制 ID。三者都必须是可逆的唯一标识，不能再按
 * macOS 的 UUID 格式一刀切。
 */
export function isDeviceId(value: string): boolean {
  const v = (value || "").trim();
  return UUID_RE.test(v) || MAC_RE.test(v) || LEGACY_RE.test(v);
}

/** UUID 小写、MAC 大写；与服务端记录和核心的 canonical_id 保持一致。 */
export function normalizeDeviceId(value: string): string | null {
  const v = (value || "").trim();
  if (!isDeviceId(v)) return null;
  return UUID_RE.test(v) ? v.toLowerCase() : v.toUpperCase();
}

function hexField(text: string, name: string): number | null {
  const m = text.match(new RegExp(`${name}=0x([0-9a-f]+)`, "i"));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}

function flagField(text: string, name: string): boolean {
  return new RegExp(`${name}=yes`, "i").test(text);
}

/**
 * 解析 `--list` 的每一行：
 * BLE <name> id=<uuid> RSSI=-61 services=<csv> manufacturer=0x5053 screen=0x134C
 *   firmware=v167(raw=0xA7) flags=0x03 secure=yes pairing=closed recovery=no turbo=yes
 *
 * 设备名可能为空（脚本写成 "(no name)"）也可能包含空格；只以 ` id=` 与
 * ` RSSI=` 作为分隔，避免贪心正则把名字吃掉。
 */
export function parseScanLine(line: string, now = Date.now()): DeviceInfo | null {
  if (!line.startsWith("BLE ")) return null;
  const idAt = line.indexOf(" id=");
  if (idAt < 0) return null;
  const name = line.slice(4, idAt).trim();
  const rest = line.slice(idAt + 4);
  const m = rest.match(/^(\S+)\s+RSSI=(-?\d*)\s+services=(\S*)(?:\s+(.*))?$/i);
  if (!m) return null;
  const id = normalizeDeviceId(m[1]);
  if (!id) return null;
  const desc = m[4] || "";
  const manufacturerId = hexField(desc, "manufacturer");
  const screenType = hexField(desc, "screen");
  const firmware = hexField(desc, "raw");
  const services = m[3] ? m[3].split(",").filter(Boolean).map((s) => s.toUpperCase()) : [];
  return {
    id,
    name: name === "(no name)" ? "" : name,
    rssi: m[2] ? Number(m[2]) : -999,
    services,
    compatible: manufacturerId === TODOCARD_MANUFACTURER && screenType === TODOCARD_SCREEN_T3,
    manufacturerId,
    screenType,
    firmware,
    secure: flagField(desc, "secure"),
    pairingOpen: /pairing=open/i.test(desc),
    recovery: flagField(desc, "recovery"),
    turbo: flagField(desc, "turbo"),
    lastSeenAt: now,
  };
}

export interface PreparedPaths {
  binPath?: string;
  legacyPath?: string;
  qlzPath?: string;
  binBytes?: number;
  legacyBytes?: number;
  qlzBytes?: number;
}

/** 从 prepare 输出里找出二进制产物路径与大小。 */
export function parsePreparedPaths(lines: string[]): PreparedPaths {
  const out: PreparedPaths = {};
  for (const line of lines) {
    let m = line.match(/^Wrote (.+?\.controller\.bin) \((\d+) bytes\)/);
    if (m) continue; // controller.bin 是屏幕控制器顺序，不用来预览
    m = line.match(/^Wrote (.+?[^.]\.bin) \((\d+) bytes\)/);
    if (m) { out.binPath = m[1]; out.binBytes = Number(m[2]); continue; }
    m = line.match(/^Wrote (.+?\.protocol\.legacy\.qlz) \((\d+) bytes\)/);
    if (m) { out.legacyPath = m[1]; out.legacyBytes = Number(m[2]); continue; }
    m = line.match(/^Prepared v157\+ payload: (.+?\.protocol\.qlz)/);
    if (m) { out.qlzPath = m[1]; continue; }
  }
  return out;
}

export interface JobOutcome {
  ok: boolean;
  summary: string;
  error: string | null;
  deviceIds?: string[];
}

export type JobKind = "install" | "scan" | "pair" | "probe" | "prepare" | "send";

function firstMatch(lines: string[], re: RegExp): string | null {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1] !== undefined ? m[1] : m[0];
  }
  return null;
}

function bluetoothError(lines: string[]): string | null {
  const state = firstMatch(lines, /^Bluetooth state: (\d+)/);
  if (!state) return null;
  switch (state) {
    case "0": return "蓝牙状态未知，请稍后重试";
    case "1": return "蓝牙正在重置，请稍后重试";
    case "2": return "此设备不支持蓝牙（或系统蓝牙不可用）";
    case "3": return "思源没有蓝牙权限：请在「系统设置 → 隐私与安全性 → 蓝牙」中允许思源";
    case "4": return "蓝牙已关闭：请先在系统设置中打开蓝牙";
    default: return null;
  }
}

function crashingError(code: number | null, signal: string | null): string | null {
  if (signal) return `核心进程被信号 ${signal} 终止`;
  if (code === 127) return "找不到 Python 解释器或 todoocard_core 模块";
  if (code === 69) return "Python 运行环境缺失，请重新安装核心";
  if (code === 64) return "核心参数错误（命令行拒绝执行）";
  return null;
}

/**
 * 结果判定完全依据上游脚本的固定输出，不猜测：
 * - 配对成功：Pairing completed.
 * - 探测成功：Probe completed:
 * - 发送成功：Transfer completed and refresh acknowledged by 0x05/0x08
 */
export function classifyOutcome(kind: JobKind, lines: string[], code: number | null, signal: string | null): JobOutcome {
  const bt = bluetoothError(lines);
  if (bt) return { ok: false, summary: "蓝牙不可用", error: bt };

  if (kind === "scan") {
    if (signal) return { ok: false, summary: "扫描已取消", error: null };
    const crash = crashingError(code, signal);
    if (crash) return { ok: false, summary: "扫描失败", error: crash };
    const failure = firstMatch(lines, /^Scan failed: (.*)/);
    if (failure) return { ok: false, summary: "扫描失败", error: failure };
    return { ok: true, summary: "扫描完成", error: null };
  }

  if (kind === "pair") {
    if (lines.some((l) => l.startsWith("Pairing completed."))) {
      return { ok: true, summary: "配对成功，系统蓝牙绑定已建立", error: null };
    }
    const failure = firstMatch(lines, /^(Transfer failed|Pairing did not complete|Timed out[^\n]*|Refusing[^\n]*|Target firmware[^\n]*|The secure bond[^\n]*)/);
    const err = failure || bluetoothError(lines) || crashingError(code, signal) || (code === 0 ? null : `配对未完成（退出码 ${code}）`);
    return { ok: false, summary: "配对未完成", error: err || "未收到配对成功确认" };
  }

  if (kind === "probe") {
    if (lines.some((l) => l.startsWith("Probe completed:"))) {
      const battery = firstMatch(lines, /Encrypted link verified; battery=(\d+)%/);
      return { ok: true, summary: battery ? `设备连接正常（电量 ${battery}%）` : "设备连接正常，加密配对已验证", error: null };
    }
    const failure = firstMatch(lines, /^(Probe ended[^\n]*|The secure bond[^\n]*|Timed out[^\n]*|Refusing[^\n]*|Discover services failed[^\n]*|Image-transfer service[^\n]*)/);
    const err = failure || bluetoothError(lines) || crashingError(code, signal) || (code === 0 ? null : `探测失败（退出码 ${code}）`);
    return { ok: false, summary: "探测失败", error: err || "未收到探测成功确认" };
  }

  if (kind === "prepare") {
    if (code !== 0) {
      const crash = crashingError(code, signal);
      const detail = firstMatch(lines, /^(Failed[^\n]*|Input image[^\n]*|Unable to[^\n]*)/);
      return { ok: false, summary: "图片校验失败", error: crash || detail || `生成失败（退出码 ${code}）` };
    }
    const paths = parsePreparedPaths(lines);
    if (!paths.qlzPath) return { ok: false, summary: "图片校验失败", error: "未生成 v157+ payload" };
    return { ok: true, summary: "图片已转换并校验（尚未发送）", error: null };
  }

  if (kind === "send") {
    if (lines.some((l) => l.includes("Transfer completed and refresh acknowledged by 0x05/0x08"))) {
      return { ok: true, summary: "发送完成，卡片已确认刷新", error: null };
    }
    const failure = firstMatch(lines, /^Transfer failed: (.*)/);
    if (failure) return { ok: false, summary: "发送失败", error: failure };
    const detail = firstMatch(lines, /^(Failure summary: [^\n]*|Timed out[^\n]*|Refusing[^\n]*|Device requested[^\n]*|Checkpoint timeout[^\n]*|Disconnected[^\n]*)/);
    const err = detail || bluetoothError(lines) || crashingError(code, signal) || (code === 0 ? null : `发送未完成（退出码 ${code}）`);
    return { ok: false, summary: "发送未完成", error: err || "未收到卡片的刷新确认，请重试" };
  }

  const crash = crashingError(code, signal);
  return code === 0
    ? { ok: true, summary: "完成", error: null }
    : { ok: false, summary: "失败", error: crash || `退出码 ${code}` };
}

export function parsePairingHintFirmware(line: string): number | null {
  const m = line.match(/firmware=v(\d+)/);
  return m ? Number(m[1]) : null;
}
