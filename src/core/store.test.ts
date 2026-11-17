import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SOURCE_URL,
  PINNED_COMMIT,
  StateStore,
  displayName,
  normalizeState,
} from "./store";

const ID = "00112233-4455-6677-8899-aabbccddeeff";
const ID2 = "ffeeddcc-bbaa-9988-7766-554433221100";
const MAC = "AA:BB:CC:DD:EE:FF";
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("默认配置", () => {
  it("默认来源指向通用核心仓库", () => {
    expect(DEFAULT_SOURCE_URL).toContain("plugin-todoocard-general-core");
    if (PINNED_COMMIT) expect(DEFAULT_SOURCE_URL).toContain(`/commit/${PINNED_COMMIT}`);
    expect(DEFAULT_SETTINGS.coreSourceUrl).toBe(DEFAULT_SOURCE_URL);
    expect(DEFAULT_SETTINGS.downloadMirror).toBe("");
  });
});

describe("normalizeState", () => {
  it("丢弃非法设备、补全字段并接受 key 作为 id", () => {
    const state = normalizeState({
      settings: { coreSourceUrl: "  https://github.com/a/b  ", autoProbeAfterPair: "yes" },
      devices: {
        [ID]: { name: "A", paired: true, alias: "书桌" },
        bad: { name: "B" },
      },
    });
    expect(state.devices[ID]).toMatchObject({ id: ID, name: "A", alias: "书桌", paired: true });
    expect(state.devices.bad).toBeUndefined();
    expect(state.settings.coreSourceUrl).toBe("https://github.com/a/b");
    expect(state.settings.autoProbeAfterPair).toBe(true);
  });

  it("接受 MAC 设备并统一大写", () => {
    const state = normalizeState({ devices: { [MAC]: { id: MAC.toLowerCase(), name: "Win" } } });
    expect(state.devices[MAC]).toMatchObject({ id: MAC, name: "Win" });
  });

  it("旧字段 sourceUrl 可迁移到 coreSourceUrl", () => {
    const state = normalizeState({ settings: { sourceUrl: "https://github.com/a/b" } });
    expect(state.settings.coreSourceUrl).toBe("https://github.com/a/b");
  });

  it("下载线路保留合法前缀并去掉首尾空白", () => {
    const state = normalizeState({
      settings: { downloadMirror: "  https://gh-proxy.com/  " },
    });
    expect(state.settings.downloadMirror).toBe("https://gh-proxy.com/");
    expect(normalizeState({ settings: { downloadMirror: "gh-proxy.com" } }).settings.downloadMirror).toBe("");
    expect(normalizeState({}).settings.downloadMirror).toBe("");
  });

  it("空来源回退到默认地址", () => {
    const state = normalizeState({ settings: { coreSourceUrl: "   " } });
    expect(state.settings.coreSourceUrl).toBe(DEFAULT_SOURCE_URL);
  });
});

describe("StateStore", () => {
  it("原子保存后可重新加载", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    store.ensureDir();
    store.mergeSeen([{
      id: ID,
      name: "Card",
      rssi: -50,
      services: [],
      compatible: true,
      manufacturerId: 0x5053,
      screenType: 0x134c,
      firmware: 0xa7,
      secure: true,
      pairingOpen: false,
      recovery: false,
      turbo: true,
      lastSeenAt: 1,
    }]);
    store.setAlias(ID, "  书桌  ");

    const loaded = new StateStore(dir).load();
    expect(loaded.devices[ID].alias).toBe("书桌");
    expect(loaded.devices[ID].compatible).toBe(true);
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "state.json.tmp"))).toBe(false);
  });

  it("再次扫描不会把设备误标为已配对，也不会清掉别名", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    store.setAlias(ID, "书房");
    store.record(ID, { paired: true, lastPairedAt: 100 });
    store.mergeSeen([{
      id: ID,
      name: "Card",
      rssi: -60,
      services: [],
      compatible: true,
      manufacturerId: 0x5053,
      screenType: 0x134c,
      firmware: 0xa7,
      secure: true,
      pairingOpen: false,
      recovery: false,
      turbo: true,
      lastSeenAt: 2,
    }]);
    expect(store.state.devices[ID].paired).toBe(true);
    expect(store.state.devices[ID].lastPairedAt).toBe(100);
    expect(store.state.devices[ID].alias).toBe("书房");
  });

  it("按大小写归一化记录与删除", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    store.record(ID2.toUpperCase(), { name: "X" });
    expect(store.state.devices[ID2]).toBeTruthy();
    store.remove(ID2.toUpperCase());
    expect(store.state.devices[ID2]).toBeUndefined();
  });

  it("损坏 JSON 回退到空状态", () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), "{bad", "utf8");
    const store = new StateStore(dir);
    expect(store.load().devices).toEqual({});
    expect(store.settings.coreSourceUrl).toBe(DEFAULT_SOURCE_URL);
  });
});

describe("displayName", () => {
  it("别名优先，其次设备名，最后短 id", () => {
    expect(displayName({ id: ID, alias: "书房", name: "Card" })).toBe("书房");
    expect(displayName({ id: ID, name: "Card" })).toBe("Card");
    expect(displayName({ id: ID })).toBe(ID.slice(0, 8));
  });
});
