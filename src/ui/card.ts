import {
  formatCardDate,
  photoWallRects,
  wrapText,
  type CardFields,
  type CardStyle,
  type Rect,
} from "../core/layout";

export interface CardImage {
  el: CanvasImageSource;
  width: number;
  height: number;
}

// 只用面板原色绘制：任何接近色都会被六色抖动成彩色噪点。
const INK = "#000000";
const PAPER = "#ffffff";
const ACCENT = "#ffff00";
const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

const IMMERSIVE_PAD = 28;
const IMMERSIVE_TITLE_SIZE = 31;
const IMMERSIVE_DATE_SIZE = 15;
const IMMERSIVE_NOTE_SIZE = 18;
const IMMERSIVE_TITLE_LH = 39;
const IMMERSIVE_DATE_LH = 22;
const IMMERSIVE_NOTE_LH = 26;

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

function contentWidth(rect: Rect, pad: number): number {
  return Math.max(1, rect.width - pad * 2);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawCover(ctx: CanvasRenderingContext2D, image: CardImage, rect: Rect, radius: number) {
  if (!(rect.width > 0) || !(rect.height > 0) || !(image.width > 0) || !(image.height > 0)) return;
  const scale = Math.max(rect.width / image.width, rect.height / image.height);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const drawX = rect.x + (rect.width - drawW) / 2;
  const drawY = rect.y + (rect.height - drawH) / 2;
  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius);
  ctx.clip();
  ctx.drawImage(image.el, drawX, drawY, drawW, drawH);
  ctx.restore();
}

function strokeRect(ctx: CanvasRenderingContext2D, rect: Rect, radius: number) {
  ctx.save();
  roundRectPath(ctx, rect.x + 1, rect.y + 1, Math.max(1, rect.width - 2), Math.max(1, rect.height - 2), Math.max(0, radius - 1));
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
): number {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, y + i * lineHeight);
  return y + lines.length * lineHeight;
}

function linesFor(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  weight: number,
  size: number,
): string[] {
  if (!text) return [];
  setFont(ctx, weight, size);
  return wrapText(text, maxWidth, (value) => ctx.measureText(value).width, maxLines);
}

function drawImmersive(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  images: CardImage[],
  title: string,
  date: string,
  note: string,
  style: CardStyle,
) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, width, height);

  const margin = Math.max(0, Math.min(style.margin, 80));
  const frame: Rect = {
    x: margin,
    y: margin,
    width: Math.max(1, width - margin * 2),
    height: Math.max(1, height - margin * 2),
  };
  const radius = Math.max(0, style.radius);
  if (images[0]) drawCover(ctx, images[0], frame, radius);

  const textWidth = contentWidth(frame, IMMERSIVE_PAD);
  const titleLines = linesFor(ctx, title, textWidth, 2, 700, IMMERSIVE_TITLE_SIZE);
  const dateLine = date ? [date] : [];
  const noteLines = linesFor(ctx, note, textWidth, 2, 400, IMMERSIVE_NOTE_SIZE);
  const hasText = !!(dateLine.length || titleLines.length || noteLines.length);

  let blockH = IMMERSIVE_PAD * 2;
  if (dateLine.length) blockH += IMMERSIVE_DATE_LH + 6;
  if (titleLines.length) blockH += titleLines.length * IMMERSIVE_TITLE_LH + 8;
  if (noteLines.length) blockH += noteLines.length * IMMERSIVE_NOTE_LH + 6;
  const bandH = hasText ? Math.min(blockH, frame.height * 0.66) : 0;
  const bandY = frame.y + frame.height - bandH;

  ctx.save();
  roundRectPath(ctx, frame.x, frame.y, frame.width, frame.height, radius);
  ctx.clip();
  if (hasText) {
    if (style.infoBand) {
      ctx.fillStyle = INK;
      ctx.fillRect(frame.x, bandY, frame.width, bandH);
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.92)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 2;
    }
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const x = frame.x + IMMERSIVE_PAD;
    let y = bandY + IMMERSIVE_PAD;

    if (dateLine.length) {
      setFont(ctx, 600, IMMERSIVE_DATE_SIZE);
      ctx.fillStyle = style.infoBand ? ACCENT : PAPER;
      y = drawLines(ctx, dateLine, x, y, IMMERSIVE_DATE_LH) + 6;
    }
    if (titleLines.length) {
      setFont(ctx, 700, IMMERSIVE_TITLE_SIZE);
      ctx.fillStyle = PAPER;
      y = drawLines(ctx, titleLines, x, y, IMMERSIVE_TITLE_LH) + 8;
    }
    if (noteLines.length) {
      setFont(ctx, 400, IMMERSIVE_NOTE_SIZE);
      ctx.fillStyle = PAPER;
      drawLines(ctx, noteLines, x, y, IMMERSIVE_NOTE_LH);
    }
  }
  ctx.restore();

  if (style.border) {
    ctx.save();
    roundRectPath(ctx, frame.x + 1, frame.y + 1, frame.width - 2, frame.height - 2, Math.max(0, radius - 1));
    ctx.lineWidth = 2;
    ctx.strokeStyle = PAPER;
    ctx.stroke();
    ctx.restore();
  }
}

function drawFramed(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  images: CardImage[],
  title: string,
  date: string,
  note: string,
  style: CardStyle,
) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  const margin = Math.max(0, Math.min(style.margin, 90));
  const content: Rect = {
    x: margin,
    y: margin,
    width: Math.max(1, width - margin * 2),
    height: Math.max(1, height - margin * 2),
  };
  const radius = Math.max(0, style.radius);
  let cursor = content.y;

  if (date) {
    setFont(ctx, 600, 14);
    ctx.fillStyle = INK;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(date, content.x, cursor);
    cursor += 22;
  }

  const titleLines = linesFor(ctx, title, content.width, 2, 700, 32);
  if (titleLines.length) {
    setFont(ctx, 700, 32);
    ctx.fillStyle = INK;
    cursor = drawLines(ctx, titleLines, content.x, cursor, 38);
  }
  if (date || titleLines.length) {
    cursor += 14;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(content.x, cursor, 44, 4);
    cursor += 20;
  }

  const noteMaxWidth = content.width - (style.infoBand ? 48 : 0);
  const noteLines = linesFor(ctx, note, noteMaxWidth, 3, 400, 18);
  const noteLineH = 26;
  const footerPad = style.infoBand ? 22 : 0;
  const footerH = noteLines.length ? noteLines.length * noteLineH + footerPad * 2 : 0;
  const footerY = content.y + content.height - footerH;
  const imageBottomGap = noteLines.length ? 18 : 0;
  const imageY = Math.min(cursor, footerY - 40);
  const imageH = Math.max(40, footerY - imageBottomGap - imageY);
  const imageRect: Rect = { x: content.x, y: imageY, width: content.width, height: imageH };

  if (images[0]) drawCover(ctx, images[0], imageRect, radius);
  if (images[0] && style.border) strokeRect(ctx, imageRect, radius);

  if (noteLines.length) {
    if (style.infoBand) {
      ctx.fillStyle = INK;
      ctx.fillRect(content.x, footerY, content.width, footerH);
      ctx.fillStyle = PAPER;
      drawLines(ctx, noteLines, content.x + 24, footerY + 22, noteLineH);
    } else {
      ctx.fillStyle = INK;
      drawLines(ctx, noteLines, content.x, footerY, noteLineH);
    }
  }
}

function drawWall(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  images: CardImage[],
  title: string,
  date: string,
  note: string,
  style: CardStyle,
) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  const margin = Math.max(0, Math.min(style.margin, 70));
  const content: Rect = {
    x: margin,
    y: margin,
    width: Math.max(1, width - margin * 2),
    height: Math.max(1, height - margin * 2),
  };
  const radius = Math.max(0, style.radius);
  let cursor = content.y;

  if (date) {
    setFont(ctx, 600, 14);
    ctx.fillStyle = INK;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(date, content.x, cursor);
    cursor += 22;
  }

  const titleLines = linesFor(ctx, title, content.width, 2, 700, 28);
  if (titleLines.length) {
    setFont(ctx, 700, 28);
    ctx.fillStyle = INK;
    cursor = drawLines(ctx, titleLines, content.x, cursor, 34);
  }
  if (date || titleLines.length) {
    cursor += 12;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(content.x, cursor, 40, 4);
    cursor += 16;
  }

  const noteMaxWidth = content.width - (style.infoBand ? 48 : 0);
  const noteLines = linesFor(ctx, note, noteMaxWidth, 2, 400, 17);
  const noteLineH = 24;
  const footerPad = style.infoBand ? 18 : 0;
  const footerH = noteLines.length ? noteLines.length * noteLineH + footerPad * 2 : 0;
  const footerY = content.y + content.height - footerH;
  const gridArea: Rect = {
    x: content.x,
    y: cursor,
    width: content.width,
    height: Math.max(60, footerY - cursor - (noteLines.length ? 12 : 0)),
  };
  const rects = photoWallRects(Math.max(1, images.length), gridArea, 8);

  for (let i = 0; i < rects.length; i++) {
    const image = images[i];
    if (!image) continue;
    drawCover(ctx, image, rects[i], radius);
    if (style.border) strokeRect(ctx, rects[i], radius);
  }

  if (noteLines.length) {
    if (style.infoBand) {
      ctx.fillStyle = INK;
      ctx.fillRect(content.x, footerY, content.width, footerH);
      ctx.fillStyle = PAPER;
      drawLines(ctx, noteLines, content.x + 24, footerY + 18, noteLineH);
    } else {
      ctx.fillStyle = INK;
      drawLines(ctx, noteLines, content.x, footerY, noteLineH);
    }
  }
}

/**
 * 直接把卡片画到 528×792 画布。所有颜色只用黑/白/黄，避免六色屏抖动出灰边。
 * 不读取、不展示 EXIF。
 */
export function renderCard(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  images: CardImage[],
  fields: CardFields,
  style: CardStyle,
) {
  const title = (fields.title || "").trim();
  const date = formatCardDate(fields.date);
  const note = (fields.note || "").trim();
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  if (style.layout === "immersive") {
    drawImmersive(ctx, width, height, images, title, date, note, style);
  } else if (style.layout === "framed") {
    drawFramed(ctx, width, height, images, title, date, note, style);
  } else {
    drawWall(ctx, width, height, images, title, date, note, style);
  }
  ctx.restore();
}
