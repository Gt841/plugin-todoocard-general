import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bingApiUrl,
  bingCacheFile,
  fetchBingWallpaper,
  findLatestBingCache,
  normalizeBingDate,
  parseBingPayload,
  type FetchLike,
} from "./bing";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todoocard-bing-"));
  dirs.push(dir);
  return dir;
}

function jpegBuffer(size = 4096): Buffer {
  const buf = Buffer.alloc(size, 0x20);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

function response(body: Buffer | object, ok = true, status = 200): any {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    arrayBuffer: async () => (
      body instanceof Buffer
        ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        : new ArrayBuffer(0)
    ),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseBingPayload", () => {
  it("解析壁纸地址、日期、标题与版权", () => {
    const meta = parseBingPayload({
      images: [{
        startdate: "20261117",
        url: "/th?id=OHR.Somewhere_ZH-CN123_1920x1080.jpg&rf=LaDigue",
        title: "山间的清晨",
        copyright: "摄影师 / Getty Images",
      }],
    }, "2026-11-17");
    expect(meta.date).toBe("2026-11-17");
    expect(meta.imageUrl).toBe("https://www.bing.com/th?id=OHR.Somewhere_ZH-CN123_1920x1080.jpg&rf=LaDigue");
    expect(meta.title).toBe("山间的清晨");
    expect(meta.copyright).toContain("Getty");
  });

  it("没有图片地址时抛错", () => {
    expect(() => parseBingPayload({ images: [] }, "2026-11-17")).toThrow("壁纸地址");
    expect(() => parseBingPayload(null, "2026-11-17")).toThrow("壁纸地址");
  });

  it("日期兼容 2026-11-17 与 20261117", () => {
    expect(normalizeBingDate("20261117", "x")).toBe("2026-11-17");
    expect(normalizeBingDate("2026-11-17", "x")).toBe("2026-11-17");
    expect(normalizeBingDate("bad", "fallback")).toBe("fallback");
  });
});

describe("fetchBingWallpaper", () => {
  it("按 idx 切换最近 8 天，并把不同日期分别缓存", async () => {
    const cacheDir = tempDir();
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes("HPImageArchive")) {
        const startdate = url.includes("idx=1") ? "20261116" : "20261117";
        return response({
          images: [{ startdate, url: `/th?id=OHR.${startdate}.jpg`, title: "测试壁纸", copyright: "test" }],
        });
      }
      return response(jpegBuffer());
    };

    const today = await fetchBingWallpaper({ cacheDir, date: "2026-11-17", fetchImpl });
    expect(today.meta.date).toBe("2026-11-17");
    const yesterday = await fetchBingWallpaper({ cacheDir, date: "2026-11-17", index: 1, fetchImpl });
    expect(yesterday.meta.date).toBe("2026-11-16");
    expect(yesterday.path).not.toBe(today.path);
    expect(fs.existsSync(bingCacheFile(cacheDir, "2026-11-16"))).toBe(true);
    expect(urls.some((url) => url.includes("idx=1"))).toBe(true);

    // 再次切到 idx=1 时命中昨天的缓存，不再下载图片。
    const again = await fetchBingWallpaper({
      cacheDir,
      date: "2026-11-17",
      index: 1,
      fetchImpl: async (url) => {
        if (url.includes("HPImageArchive")) {
          return response({
            images: [{ startdate: "20261116", url: "/th?id=OHR.20261116.jpg", title: "测试壁纸", copyright: "test" }],
          });
        }
        throw new Error("should not download image");
      },
    });
    expect(again.cached).toBe(true);
    expect(again.path).toBe(yesterday.path);
  });

  it("idx 会限制在 0–7", () => {
    expect(bingApiUrl(-3)).toContain("idx=0&");
    expect(bingApiUrl(12)).toContain("idx=7&");
    expect(bingApiUrl(3)).toContain("idx=3&");
  });

  it("下载后写入 cache，当天再次获取直接复用", async () => {
    const cacheDir = tempDir();
    let calls = 0;
    const fetchImpl: FetchLike = async (url) => {
      calls++;
      if (url.includes("HPImageArchive")) {
        return response({
          images: [{ startdate: "20261117", url: "/th?id=OHR.Test.jpg", title: "测试壁纸", copyright: "test" }],
        });
      }
      return response(jpegBuffer());
    };

    const first = await fetchBingWallpaper({ cacheDir, date: "2026-11-17", fetchImpl });
    expect(first.cached).toBe(false);
    expect(first.stale).toBe(false);
    expect(first.meta.title).toBe("测试壁纸");
    expect(fs.existsSync(first.path)).toBe(true);
    expect(fs.statSync(first.path).size).toBe(4096);
    expect(calls).toBe(2);

    const second = await fetchBingWallpaper({
      cacheDir,
      date: "2026-11-17",
      fetchImpl: async () => { throw new Error("should not fetch"); },
    });
    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it("网络失败时回退到最近缓存", async () => {
    const cacheDir = tempDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    const oldDate = "2026-11-16";
    const oldFile = bingCacheFile(cacheDir, oldDate);
    fs.writeFileSync(oldFile, jpegBuffer(2048));
    fs.writeFileSync(
      path.join(cacheDir, `bing-${oldDate}.json`),
      JSON.stringify({ date: oldDate, title: "昨天的壁纸", copyright: "", imageUrl: "https://example.com/a.jpg" }),
    );

    const result = await fetchBingWallpaper({
      cacheDir,
      date: "2026-11-17",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    expect(result.path).toBe(oldFile);
    expect(result.meta.title).toBe("昨天的壁纸");
    expect(result.stale).toBe(true);
    expect(findLatestBingCache(cacheDir)?.path).toBe(oldFile);
  });

  it("没有缓存且网络失败时给出明确错误", async () => {
    const cacheDir = tempDir();
    await expect(fetchBingWallpaper({
      cacheDir,
      date: "2026-11-17",
      fetchImpl: async () => { throw new Error("offline"); },
    })).rejects.toThrow("获取 Bing 壁纸失败");
  });

  it("接口返回非 200 时不会写入坏文件", async () => {
    const cacheDir = tempDir();
    await expect(fetchBingWallpaper({
      cacheDir,
      date: "2026-11-17",
      fetchImpl: async () => response({}, false, 503),
    })).rejects.toThrow("503");
    expect(fs.existsSync(bingCacheFile(cacheDir, "2026-11-17"))).toBe(false);
  });
});
