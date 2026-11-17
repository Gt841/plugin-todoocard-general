import { PANEL_HEIGHT, PANEL_WIDTH } from "../types";

export const MAX_CARD_IMAGES = 6;

/** 三套固定版式：满版图文、留白图文、照片墙。 */
export type CardLayout = "immersive" | "framed" | "wall";

export interface CardFields {
  title: string;
  date: string;
  note: string;
}

export interface CardStyle {
  layout: CardLayout;
  /** 图片圆角，0 表示直角。 */
  radius: number;
  /** 是否给图片描边。 */
  border: boolean;
  /** 页面留白；满版版式中表示图片内缩。 */
  margin: number;
  /** 是否使用底部信息带。 */
  infoBand: boolean;
}

export interface LayoutPreset {
  id: CardLayout;
  name: string;
  hint: string;
  style: CardStyle;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PRESET_STYLES: Record<CardLayout, Omit<CardStyle, "layout">> = {
  immersive: { radius: 0, border: false, margin: 0, infoBand: true },
  framed: { radius: 24, border: false, margin: 28, infoBand: false },
  wall: { radius: 12, border: false, margin: 24, infoBand: false },
};

export const CARD_LAYOUTS: LayoutPreset[] = [
  {
    id: "immersive",
    name: "整图标题",
    hint: "满版照片 · 底部信息带",
    style: { layout: "immersive", ...PRESET_STYLES.immersive },
  },
  {
    id: "framed",
    name: "留白图文",
    hint: "白底留白 · 圆角照片",
    style: { layout: "framed", ...PRESET_STYLES.framed },
  },
  {
    id: "wall",
    name: "照片墙",
    hint: "2–6 张拼版 · 标题日期",
    style: { layout: "wall", ...PRESET_STYLES.wall },
  },
];

export function cardStyleFor(layout: CardLayout): CardStyle {
  return { layout, ...PRESET_STYLES[layout] };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 日期输入框用的本地日期，避免 toISOString 在晚上 8 点后跨到第二天。 */
export function todayCardDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** `2026-11-17`、`2026/11/17`、`20261117` 都显示为 `2026.11.17`。 */
export function formatCardDate(raw: string): string {
  const text = (raw || "").trim();
  const separated = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (separated) return `${separated[1]}.${pad2(Number(separated[2]))}.${pad2(Number(separated[3]))}`;
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}.${compact[2]}.${compact[3]}`;
  return text;
}

function ellipsize(text: string, maxWidth: number, measure: (text: string) => number): string {
  let out = text.trimEnd();
  while (out.length > 0 && measure(out + "…") > maxWidth) {
    out = out.slice(0, -1).trimEnd();
  }
  return out + "…";
}

/**
 * 按像素宽度换行。中文按字断行，英文优先在空格处断开；超过 maxLines 时在末行加省略号。
 * measure 由 Canvas 的 measureText 提供，纯函数便于单测。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
  maxLines = 3,
): string[] {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean || maxLines <= 0 || !(maxWidth > 0)) return [];
  const chars = Array.from(clean);
  const lines: string[] = [];
  let line = "";
  let index = 0;

  while (index < chars.length && lines.length < maxLines) {
    const ch = chars[index];
    if (!line && ch === " ") { index++; continue; }
    const candidate = line + ch;
    if (line && measure(candidate) > maxWidth) {
      const breakAt = line.lastIndexOf(" ");
      if (breakAt > 0) {
        lines.push(line.slice(0, breakAt).trimEnd());
        line = (line.slice(breakAt + 1) + ch).trimStart();
        index++;
        continue;
      }
      lines.push(line.trimEnd());
      line = "";
      continue;
    }
    line = candidate;
    index++;
  }

  if (lines.length < maxLines && line.trim()) lines.push(line.trim());
  if (index < chars.length) {
    if (!lines.length) lines.push("");
    lines[lines.length - 1] = ellipsize(lines[lines.length - 1], maxWidth, measure);
  }
  return lines;
}

function gridRects(area: Rect, rows: number, cols: number, gap: number): Rect[] {
  const cellW = (area.width - gap * (cols - 1)) / cols;
  const cellH = (area.height - gap * (rows - 1)) / rows;
  const out: Rect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out.push({
        x: area.x + col * (cellW + gap),
        y: area.y + row * (cellH + gap),
        width: cellW,
        height: cellH,
      });
    }
  }
  return out;
}

/**
 * 照片墙固定格。支持 1–6 张：
 * 2 张上下；3 张左大右二；4 张 2×2；5 张上二下三；6 张 2×3。
 */
export function photoWallRects(count: number, area: Rect, gap = 8): Rect[] {
  if (!(area.width > 0) || !(area.height > 0) || count <= 0) return [];
  const n = Math.min(6, Math.round(count));
  const g = Math.max(0, Math.min(gap, area.width / 4, area.height / 4));

  if (n === 1) return [{ ...area }];
  if (n === 2) return gridRects(area, 2, 1, g);
  if (n === 3) {
    const leftW = (area.width - g) * 0.6;
    const rightW = area.width - g - leftW;
    const rowH = (area.height - g) / 2;
    return [
      { x: area.x, y: area.y, width: leftW, height: area.height },
      { x: area.x + leftW + g, y: area.y, width: rightW, height: rowH },
      { x: area.x + leftW + g, y: area.y + rowH + g, width: rightW, height: rowH },
    ];
  }
  if (n === 4) return gridRects(area, 2, 2, g);
  if (n === 5) {
    const topH = (area.height - g) * 0.55;
    const bottomH = area.height - g - topH;
    const topW = (area.width - g) / 2;
    const bottomW = (area.width - g * 2) / 3;
    return [
      { x: area.x, y: area.y, width: topW, height: topH },
      { x: area.x + topW + g, y: area.y, width: topW, height: topH },
      { x: area.x, y: area.y + topH + g, width: bottomW, height: bottomH },
      { x: area.x + bottomW + g, y: area.y + topH + g, width: bottomW, height: bottomH },
      { x: area.x + (bottomW + g) * 2, y: area.y + topH + g, width: bottomW, height: bottomH },
    ];
  }
  return gridRects(area, 3, 2, g);
}

/** 画布与卡片尺寸固定，页面缩放时预览只缩放显示，不改变排版。 */
export const CARD_CANVAS = { width: PANEL_WIDTH, height: PANEL_HEIGHT };
