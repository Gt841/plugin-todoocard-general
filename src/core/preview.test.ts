import { describe, expect, it } from "vitest";
import { PREVIEW_PALETTE, decodePayloadBin } from "./preview";

describe("decodePayloadBin", () => {
  it("按高半字节在前解出 4bit 调色板，并上下翻回正向", () => {
    // 1×2 像素共 1 字节：0x12 → idx0 低半字节=2（黄），idx1 高半字节=1（白）。
    // .bin 行序是上下颠倒的，所以显示的第一行来自源图第二行。
    const b64 = Buffer.from([0x12]).toString("base64");
    const out = decodePayloadBin(b64, 1, 2);
    expect(out).toHaveLength(8);
    expect(Array.from(out.slice(0, 4))).toEqual([...PREVIEW_PALETTE[2], 255]);
    expect(Array.from(out.slice(4, 8))).toEqual([...PREVIEW_PALETTE[1], 255]);
  });

  it("未知色号回退到 7 号灰", () => {
    const b64 = Buffer.from([0x04]).toString("base64");
    const out = decodePayloadBin(b64, 1, 2, { 0: [1, 2, 3], 7: [9, 9, 9] });
    expect(Array.from(out.slice(0, 4))).toEqual([9, 9, 9, 255]);
  });
});
