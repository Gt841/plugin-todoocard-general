import { describe, expect, it } from "vitest";
import { normalizeSendTargets, summarizeBatch } from "./batch";

const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const C = "cccccccc-1111-2222-3333-444444444444";

describe("normalizeSendTargets", () => {
  it("保留顺序、大小写归一化，并过滤未配对设备", () => {
    expect(normalizeSendTargets([B.toUpperCase(), A, C], [A, B], null)).toEqual([B, A]);
  });

  it("去重", () => {
    expect(normalizeSendTargets([A, A, B], [A, B], null)).toEqual([A, B]);
  });

  it("没有显式目标时回退到当前选中设备", () => {
    expect(normalizeSendTargets(undefined, [A, B], B)).toEqual([B]);
    expect(normalizeSendTargets([], [A, B], A)).toEqual([A]);
  });

  it("回退设备未配对或缺失时返回空列表", () => {
    expect(normalizeSendTargets(undefined, [A], C)).toEqual([]);
    expect(normalizeSendTargets(undefined, [], null)).toEqual([]);
  });
});

describe("summarizeBatch", () => {
  it("全部成功", () => {
    const s = summarizeBatch([
      { id: A, name: "书桌", ok: true },
      { id: B, name: "客厅", ok: true },
    ]);
    expect(s.ok).toBe(true);
    expect(s.sent).toBe(2);
    expect(s.failed).toBe(0);
    expect(s.summary).toContain("2 台");
    expect(s.error).toBeUndefined();
  });

  it("部分成功时给出失败明细", () => {
    const s = summarizeBatch([
      { id: A, name: "书桌", ok: true },
      { id: B, name: "客厅", ok: false, error: "连接超时" },
    ]);
    expect(s.ok).toBe(false);
    expect(s.sent).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.summary).toContain("失败 1 台");
    expect(s.error).toContain("客厅");
    expect(s.error).toContain("连接超时");
  });

  it("全部失败", () => {
    const s = summarizeBatch([{ id: A, name: "书桌", ok: false, error: "未找到设备" }]);
    expect(s.ok).toBe(false);
    expect(s.summary).toContain("发送失败");
    expect(s.error).toContain("未找到设备");
  });

  it("空批次", () => {
    const s = summarizeBatch([]);
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
  });
});
