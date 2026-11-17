import fs from "fs";
import path from "path";

const BING_API_BASE = "https://www.bing.com/HPImageArchive.aspx?format=js";
/** Bing 归档最多提供最近 8 天，idx 从 0（今天）到 7。 */
export const BING_MAX_INDEX = 7;
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  accept: "application/json,image/jpeg,image/*;q=0.8,*/*;q=0.5",
};

export function bingApiUrl(index = 0): string {
  const idx = Math.max(0, Math.min(BING_MAX_INDEX, Math.round(index) || 0));
  return `${BING_API_BASE}&idx=${idx}&n=1&mkt=zh-CN`;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export interface BingWallpaperMeta {
  date: string;
  title: string;
  copyright: string;
  imageUrl: string;
}

export interface BingWallpaperResult {
  path: string;
  meta: BingWallpaperMeta;
  /** 网络失败时使用了本地旧缓存。 */
  stale: boolean;
  /** 当天缓存直接复用，没有重新下载。 */
  cached: boolean;
}

export interface FetchBingOptions {
  cacheDir: string;
  /** 便于测试固定日期；默认本地今天。 */
  date?: string;
  /** 归档位置：0 是今天，1 是昨天，最多 7；用于重复点击切换壁纸。 */
  index?: number;
  fetchImpl?: FetchLike;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDateStamp(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function normalizeBingDate(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return fallback;
}

function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parseBingPayload(payload: unknown, fallbackDate: string): BingWallpaperMeta {
  const images = (payload as { images?: unknown[] } | null)?.images;
  const first = Array.isArray(images) ? (images[0] as Record<string, unknown> | undefined) : undefined;
  const rawUrl = typeof first?.url === "string" ? first.url.trim() : "";
  if (!rawUrl) throw new Error("Bing 返回内容不包含壁纸地址");
  const imageUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://www.bing.com${rawUrl}`;
  return {
    date: normalizeBingDate(first?.startdate, fallbackDate),
    title: cleanText(first?.title, "Bing 每日壁纸"),
    copyright: cleanText(first?.copyright),
    imageUrl,
  };
}

export function bingCacheFile(cacheDir: string, date: string): string {
  return path.join(cacheDir, `bing-${date}.jpg`);
}

function bingMetaFile(cacheDir: string, date: string): string {
  return path.join(cacheDir, `bing-${date}.json`);
}

function readCachedMeta(cacheDir: string, date: string, imageUrl = ""): BingWallpaperMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(bingMetaFile(cacheDir, date), "utf8")) as Partial<BingWallpaperMeta>;
    return {
      date: normalizeBingDate(raw.date, date),
      title: cleanText(raw.title, "Bing 每日壁纸"),
      copyright: cleanText(raw.copyright),
      imageUrl: cleanText(raw.imageUrl, imageUrl),
    };
  } catch {
    return null;
  }
}

function minimalMeta(date: string, imageUrl = ""): BingWallpaperMeta {
  return { date, title: "Bing 每日壁纸", copyright: "", imageUrl };
}

export function findLatestBingCache(cacheDir: string): { path: string; meta: BingWallpaperMeta } | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return null;
  }
  const files = names
    .filter((name) => /^bing-\d{4}-\d{2}-\d{2}\.jpg$/.test(name))
    .sort()
    .reverse();
  for (const name of files) {
    const file = path.join(cacheDir, name);
    try {
      if (fs.statSync(file).size < 1024) continue;
    } catch {
      continue;
    }
    const date = name.slice("bing-".length, -".jpg".length);
    return { path: file, meta: readCachedMeta(cacheDir, date) || minimalMeta(date) };
  }
  return null;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

async function saveAtomically(file: string, data: Buffer | string) {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

/**
 * 获取 Bing 每日壁纸。当天已缓存就直接复用；网络失败时回退到最近的本地缓存，
 * 这样离线或 Bing 接口临时不可用时仍能排版。index 用于在最近 8 天之间切换。
 */
export async function fetchBingWallpaper(opts: FetchBingOptions): Promise<BingWallpaperResult> {
  const date = opts.date || localDateStamp();
  const cacheDir = opts.cacheDir;
  const index = Math.max(0, Math.min(BING_MAX_INDEX, Math.round(opts.index ?? 0)));
  const cacheFile = bingCacheFile(cacheDir, date);

  try {
    if (index === 0 && fs.statSync(cacheFile).size > 1024) {
      return {
        path: cacheFile,
        meta: readCachedMeta(cacheDir, date) || minimalMeta(date),
        stale: false,
        cached: true,
      };
    }
  } catch {}

  const fetcher: FetchLike = opts.fetchImpl || (globalThis.fetch as unknown as FetchLike);
  try {
    const apiRes = await fetcher(bingApiUrl(index), { headers: REQUEST_HEADERS });
    if (!apiRes.ok) throw new Error(`接口返回 HTTP ${apiRes.status}`);
    const meta = parseBingPayload(await apiRes.json(), date);

    // 归档里的图片按它自己的日期缓存，切换 idx 时不会互相覆盖。
    const metaFile = bingCacheFile(cacheDir, meta.date);
    try {
      if (fs.statSync(metaFile).size > 1024) {
        return {
          path: metaFile,
          meta: readCachedMeta(cacheDir, meta.date) || meta,
          stale: false,
          cached: true,
        };
      }
    } catch {}

    const imageRes = await fetcher(meta.imageUrl, { headers: REQUEST_HEADERS });
    if (!imageRes.ok) throw new Error(`壁纸下载返回 HTTP ${imageRes.status}`);
    const buf = Buffer.from(await imageRes.arrayBuffer());
    if (buf.length < 1024) throw new Error("壁纸文件为空或过小");
    if (!isJpeg(buf)) throw new Error("Bing 返回的不是 JPEG 图片");

    await fs.promises.mkdir(cacheDir, { recursive: true });
    await saveAtomically(metaFile, buf);
    await saveAtomically(bingMetaFile(cacheDir, meta.date), JSON.stringify(meta, null, 2));
    return { path: metaFile, meta, stale: false, cached: false };
  } catch (error) {
    const cached = findLatestBingCache(cacheDir);
    if (cached) return { ...cached, stale: true, cached: true };
    throw new Error(`获取 Bing 壁纸失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
