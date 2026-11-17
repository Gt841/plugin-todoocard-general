import { describe, expect, it } from "vitest";
import {
  cardStyleFor,
  formatCardDate,
  photoWallRects,
  todayCardDate,
  wrapText,
  type Rect,
} from "./layout";

const measure = (text: string) => Array.from(text).length * 10;

function expectInside(rects: Rect[], area: Rect) {
  for (const r of rects) {
    expect(r.x).toBeGreaterThanOrEqual(area.x - 0.001);
    expect(r.y).toBeGreaterThanOrEqual(area.y - 0.001);
    expect(r.x + r.width).toBeLessThanOrEqual(area.x + area.width + 0.001);
    expect(r.y + r.height).toBeLessThanOrEqual(area.y + area.height + 0.001);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  }
}

describe("cardStyleFor", () => {
  it("三套版式返回独立的默认样式", () => {
    const immersive = cardStyleFor("immersive");
    const framed = cardStyleFor("framed");
    const wall = cardStyleFor("wall");
    expect(immersive.layout).toBe("immersive");
    expect(immersive.infoBand).toBe(true);
    expect(framed.radius).toBeGreaterThan(0);
    expect(framed.margin).toBeGreaterThan(0);
    expect(wall.layout).toBe("wall");
    immersive.radius = 99;
    expect(cardStyleFor("immersive").radius).toBe(0);
  });
});

describe("todayCardDate / formatCardDate", () => {
  it("使用本地日期并补零", () => {
    expect(todayCardDate(new Date(2026, 0, 2))).toBe("2026-01-02");
    expect(todayCardDate(new Date(2026, 10, 17))).toBe("2026-11-17");
  });

  it("统一日期分隔符", () => {
    expect(formatCardDate("2026-11-17")).toBe("2026.11.17");
    expect(formatCardDate("2026/1/2")).toBe("2026.01.02");
    expect(formatCardDate("20261117")).toBe("2026.11.17");
    expect(formatCardDate("某个下午")).toBe("某个下午");
    expect(formatCardDate("")).toBe("");
  });
});

describe("wrapText", () => {
  it("空文本返回空数组", () => {
    expect(wrapText("   ", 100, measure)).toEqual([]);
  });

  it("按像素宽度换行", () => {
    expect(wrapText("abcdefghi", 30, measure)).toEqual(["abc", "def", "ghi"]);
  });

  it("中文按字换行", () => {
    expect(wrapText("把今天的光景留在卡片上", 50, measure)).toEqual(["把今天的光", "景留在卡片", "上"]);
  });

  it("超过行数时末行加省略号且不超宽", () => {
    const lines = wrapText("abcdefghijklmnopqrst", 30, measure, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith("…")).toBe(true);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(30);
  });

  it("英文优先在空格处断开", () => {
    expect(wrapText("hello world again", 70, measure, 3)).toEqual(["hello", "world", "again"]);
  });
});

describe("photoWallRects", () => {
  const area = { x: 24, y: 100, width: 480, height: 500 };

  it("1 张铺满照片区", () => {
    expect(photoWallRects(1, area)).toEqual([area]);
  });

  it("2–6 张都落在照片区内且数量正确", () => {
    for (let count = 2; count <= 6; count++) {
      const rects = photoWallRects(count, area, 8);
      expect(rects).toHaveLength(count);
      expectInside(rects, area);
    }
  });

  it("3 张为左大右二", () => {
    const rects = photoWallRects(3, area, 8);
    expect(rects[0].height).toBe(area.height);
    expect(rects[1].height).toBeCloseTo((area.height - 8) / 2);
    expect(rects[2].y).toBeCloseTo(rects[1].y + rects[1].height + 8);
  });

  it("6 张为 2 列 3 行", () => {
    const rects = photoWallRects(6, area, 8);
    expect(rects[0].y).toBe(area.y);
    expect(rects[2].y).toBeGreaterThan(rects[0].y);
    expect(rects[1].x).toBeGreaterThan(rects[0].x);
  });

  it("超出范围按 6 张处理，0 张返回空", () => {
    expect(photoWallRects(9, area, 8)).toHaveLength(6);
    expect(photoWallRects(0, area, 8)).toEqual([]);
  });
});
