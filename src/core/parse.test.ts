import { describe, expect, it } from "vitest";
import { classifyOutcome, isDeviceId, normalizeDeviceId, parsePreparedPaths, parseScanLine } from "./parse";

const ID = "00112233-4455-6677-8899-aabbccddeeff";
const MAC = "AA:BB:CC:DD:EE:FF";

describe("parseScanLine", () => {
  it("解析带名字、服务和能力位的设备行", () => {
    const line = `BLE Desk Card id=${ID} RSSI=-61 services=180F,FFF0 manufacturer=0x5053 screen=0x134C firmware=v167(raw=0xA7) flags=0x03 secure=yes pairing=closed recovery=no turbo=yes`;
    const dev = parseScanLine(line, 1234);
    expect(dev).toMatchObject({
      id: ID,
      name: "Desk Card",
      rssi: -61,
      services: ["180F", "FFF0"],
      compatible: true,
      manufacturerId: 0x5053,
      screenType: 0x134c,
      firmware: 0xa7,
      secure: true,
      pairingOpen: false,
      recovery: false,
      turbo: true,
      lastSeenAt: 1234,
    });
  });

  it("兼容空名字与配对窗口打开", () => {
    const dev = parseScanLine(`BLE (no name) id=${ID} RSSI=-70 services= pairing=open`);
    expect(dev?.name).toBe("");
    expect(dev?.pairingOpen).toBe(true);
    expect(dev?.compatible).toBe(false);
    expect(dev?.firmware).toBeNull();
  });

  it("解析 Windows MAC 地址并统一大写", () => {
    const dev = parseScanLine(`BLE Card id=${MAC.toLowerCase()} RSSI=-55 services=180F manufacturer=0x5053 screen=0x134C`);
    expect(dev?.id).toBe(MAC);
    expect(dev?.compatible).toBe(true);
  });

  it("RSSI 缺失时用 -999 参与排序，不丢设备", () => {
    const dev = parseScanLine(`BLE Card id=${ID} RSSI= services=`);
    expect(dev?.id).toBe(ID);
    expect(dev?.rssi).toBe(-999);
  });

  it("忽略非 BLE 行与残缺 ID", () => {
    expect(parseScanLine("Bluetooth state: 3")).toBeNull();
    expect(parseScanLine("BLE x id=not-a-uuid RSSI=-1 services=")).toBeNull();
    expect(parseScanLine(`BLE x id=${ID} RSSI=-1`)).toBeNull();
  });
});

describe("parsePreparedPaths", () => {
  it("区分 controller.bin 与用于预览的 image.bin", () => {
    const paths = parsePreparedPaths([
      "Wrote /tmp/a/.controller.bin (209088 bytes)",
      "Wrote /tmp/a/image.bin (209088 bytes)",
      "Wrote /tmp/a/image.protocol.legacy.qlz (218893 bytes)",
      "Prepared v157+ payload: /tmp/a/image.protocol.qlz",
    ]);
    expect(paths.binPath).toBe("/tmp/a/image.bin");
    expect(paths.binBytes).toBe(209088);
    expect(paths.legacyPath).toBe("/tmp/a/image.protocol.legacy.qlz");
    expect(paths.qlzPath).toBe("/tmp/a/image.protocol.qlz");
  });
});

describe("classifyOutcome", () => {
  it("配对成功只认固定文案", () => {
    expect(classifyOutcome("pair", ["Pairing completed."], 0, null)).toMatchObject({ ok: true });
    expect(classifyOutcome("pair", ["Pairing did not complete: button not pressed"], 1, null).error)
      .toContain("Pairing did not complete");
  });

  it("探测成功会带出电量", () => {
    const out = classifyOutcome("probe", ["Probe completed:", "Encrypted link verified; battery=87%"], 0, null);
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("87%");
  });

  it("发送成功要求 0x05/0x08 刷新确认", () => {
    expect(classifyOutcome("send", ["Transfer completed and refresh acknowledged by 0x05/0x08"], 0, null).ok).toBe(true);
    expect(classifyOutcome("send", ["Transfer completed"], 0, null)).toMatchObject({ ok: false, summary: "发送未完成" });
  });

  it("蓝牙权限/开关错误优先于退出码", () => {
    const out = classifyOutcome("scan", ["Bluetooth state: 3", "scan failed"], 1, null);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("蓝牙权限");
    expect(classifyOutcome("scan", ["Bluetooth state: 4"], 1, null).error).toContain("蓝牙已关闭");
  });

  it("通用核心的 Scan failed 行直接作为错误", () => {
    const out = classifyOutcome("scan", ["Scan failed: 蓝牙不可用：请打开系统蓝牙"], 3, null);
    expect(out).toMatchObject({ ok: false, summary: "扫描失败" });
    expect(out.error).toContain("蓝牙不可用");
  });

  it("prepare 必须有 v157+ payload", () => {
    expect(classifyOutcome("prepare", ["Wrote /tmp/image.bin (1 bytes)"], 0, null).ok).toBe(false);
    expect(classifyOutcome("prepare", ["Prepared v157+ payload: /tmp/x.protocol.qlz"], 0, null).ok).toBe(true);
  });

  it("取消扫描不算失败错误", () => {
    expect(classifyOutcome("scan", [], null, "SIGTERM")).toMatchObject({ ok: false, error: null });
  });
});

describe("isDeviceId", () => {
  it("接受 UUID、MAC 与裸十六进制", () => {
    expect(isDeviceId(ID.toUpperCase())).toBe(true);
    expect(isDeviceId(MAC)).toBe(true);
    expect(isDeviceId("aa-bb-cc-dd-ee-ff")).toBe(true);
    expect(isDeviceId("AABBCCDDEEFF")).toBe(true);
    expect(isDeviceId("00112233-4455-6677-8899-aabbccddeef")).toBe(false);
    expect(isDeviceId("not-a-device")).toBe(false);
  });

  it("归一化：UUID 小写、MAC 大写", () => {
    expect(normalizeDeviceId(ID.toUpperCase())).toBe(ID);
    expect(normalizeDeviceId(MAC.toLowerCase())).toBe(MAC);
    expect(normalizeDeviceId("bad id")).toBeNull();
  });
});
