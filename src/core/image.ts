import fs from "fs";
import path from "path";
import { runSpawn } from "./fsutil";
import { tempImageDir } from "./paths";

declare const window: any;

export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp"];

export function isImageFile(file: string): boolean {
  return IMAGE_EXTS.includes(path.extname(file).toLowerCase());
}

export interface ImageMeta {
  width: number;
  height: number;
  bytes: number;
}

export function validateImageMeta(meta: ImageMeta): void {
  if (meta.bytes > 100 * 1024 * 1024) throw new Error("图片超过 100 MB 上限");
  if (meta.width <= 0 || meta.height <= 0) throw new Error("无法读取图片尺寸");
  if (meta.width * meta.height > 50_000_000) throw new Error("图片超过 5000 万像素上限");
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.slice(1, 4).toString() !== "PNG") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Electron 自带解码器；渲染进程里可用，单元测试环境里为 null。 */
function electronNativeImage(): any {
  try {
    if (typeof window === "undefined") return null;
    const electron = window.require?.("electron");
    const remote = window.require?.("@electron/remote");
    return electron?.nativeImage || remote?.nativeImage || null;
  } catch {
    return null;
  }
}

function nativeImageMeta(file: string): { width: number; height: number } | null {
  try {
    const image = electronNativeImage()?.createFromPath(file);
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    if (!size?.width || !size?.height) return null;
    return { width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/**
 * 尺寸读取顺序：PNG/JPEG 文件头（最便宜）→ Electron 解码器 → macOS sips
 * （补充 HEIC）。Windows 没有 sips，HEIC 预览需要系统解码器或先转成 JPG/PNG。
 */
export async function readImageMeta(file: string): Promise<ImageMeta> {
  const bytes = fs.statSync(file).size;
  const buf = fs.readFileSync(file);
  const header = pngSize(buf) || jpegSize(buf);
  if (header) return { ...header, bytes };

  const native = nativeImageMeta(file);
  if (native) return { ...native, bytes };

  if (process.platform === "darwin") {
    const r = await runSpawn("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { timeoutMs: 15000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const w = text.match(/pixelWidth:\s*(\d+)/);
    const h = text.match(/pixelHeight:\s*(\d+)/);
    if (w && h) return { width: Number(w[1]), height: Number(h[1]), bytes };
  }
  throw new Error("无法识别图片尺寸，请换一张 JPG/PNG 图片");
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
};

export function dataUrlFor(file: string): string {
  const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

/**
 * HEIC/TIFF/BMP 在 Chromium 里无法直接预览。先让 Electron 解码成 PNG；macOS
 * 再用 sips 兜底 HEIC。发送时仍使用原图，由通用核心自己完成 EXIF 与缩放。
 */
export async function previewDataUrl(file: string, cacheDir: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return dataUrlFor(file);

  try {
    const image = electronNativeImage()?.createFromPath(file);
    if (image && !image.isEmpty()) {
      const png = image.toPNG();
      if (png?.length) return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    }
  } catch {}

  if (process.platform === "darwin") {
    fs.mkdirSync(cacheDir, { recursive: true });
    const out = path.join(cacheDir, `preview-${Date.now()}.png`);
    const r = await runSpawn("/usr/bin/sips", ["-s", "format", "png", file, "--out", out], { timeoutMs: 30000 });
    if (r.code === 0 && fs.existsSync(out)) return dataUrlFor(out);
  }
  throw new Error("无法生成该格式的预览，请先转成 JPG/PNG");
}

export function ensureTempImageDir(): string {
  const dir = tempImageDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function savePastedPng(png: Buffer): string {
  const dir = ensureTempImageDir();
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const file = path.join(dir, `screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`);
  fs.writeFileSync(file, png);
  return file;
}

export function saveDroppedImage(bytes: Buffer, name: string): string {
  const dir = ensureTempImageDir();
  const ext = path.extname(name).toLowerCase() || ".png";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const file = path.join(dir, `drop-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** 清理两小时前的截图缓存，避免长期占用 /tmp。 */
export function cleanupTempImages(maxAgeMs = 2 * 60 * 60 * 1000): void {
  const dir = tempImageDir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file, { force: true });
    } catch {}
  }
}
