import { describe, expect, it } from "vitest";
import { computeCropGeometry, panCropCenter } from "./crop";

describe("computeCropGeometry", () => {
  it("横图在 1 倍时铺满高度，并水平居中裁切", () => {
    const g = computeCropGeometry({ sourceWidth: 4000, sourceHeight: 3000 });
    expect(g.effectiveWidth).toBe(4000);
    expect(g.effectiveHeight).toBe(3000);
    expect(g.cropWidth).toBeCloseTo(2000);
    expect(g.cropHeight).toBeCloseTo(3000);
    expect(g.sourceX).toBeCloseTo(1000);
    expect(g.sourceY).toBeCloseTo(0);
  });

  it("竖图在 1 倍时铺满宽度，并垂直居中裁切", () => {
    const g = computeCropGeometry({ sourceWidth: 2000, sourceHeight: 4000 });
    expect(g.cropWidth).toBeCloseTo(2000);
    expect(g.cropHeight).toBeCloseTo(3000);
    expect(g.sourceX).toBeCloseTo(0);
    expect(g.sourceY).toBeCloseTo(500);
  });

  it("比例恰好为 2:3 时保留完整画面", () => {
    const g = computeCropGeometry({ sourceWidth: 528, sourceHeight: 792 });
    expect(g.cropWidth).toBe(528);
    expect(g.cropHeight).toBe(792);
    expect(g.sourceX).toBe(0);
    expect(g.sourceY).toBe(0);
  });

  it("放大取景时裁切尺寸按倍率缩小", () => {
    const g = computeCropGeometry({ sourceWidth: 4000, sourceHeight: 3000, zoom: 2 });
    expect(g.cropWidth).toBeCloseTo(1000);
    expect(g.cropHeight).toBeCloseTo(1500);
    expect(g.sourceX).toBeCloseTo(1500);
    expect(g.sourceY).toBeCloseTo(750);
  });

  it("中心靠近边缘时自动夹回图像内", () => {
    const g = computeCropGeometry({
      sourceWidth: 4000,
      sourceHeight: 3000,
      zoom: 1.5,
      centerX: 0,
      centerY: 1,
    });
    expect(g.sourceX).toBe(0);
    expect(g.sourceY + g.cropHeight).toBeCloseTo(3000);
  });

  it("旋转后按交换后的宽高计算取景", () => {
    const g = computeCropGeometry({ sourceWidth: 4000, sourceHeight: 3000, rotated: true });
    expect(g.effectiveWidth).toBe(3000);
    expect(g.effectiveHeight).toBe(4000);
    expect(g.cropWidth).toBeCloseTo(2666.67, 1);
    expect(g.cropHeight).toBeCloseTo(4000);
    expect(g.sourceX).toBeCloseTo(166.67, 1);
    expect(g.sourceY).toBeCloseTo(0);
  });
});

describe("panCropCenter", () => {
  it("拖动方向与画面移动方向一致，并受边界约束", () => {
    const g = computeCropGeometry({ sourceWidth: 4000, sourceHeight: 3000 });
    const moved = panCropCenter(g, 100, 0, 400, 600);
    expect(moved.centerX).toBeLessThan(g.centerX);
    expect(moved.centerY).toBeCloseTo(g.centerY);

    const clamped = panCropCenter(g, 100000, 100000, 400, 600);
    expect(clamped.centerX).toBeCloseTo(g.minCenterX);
    expect(clamped.centerY).toBeCloseTo(g.minCenterY);
  });
});
