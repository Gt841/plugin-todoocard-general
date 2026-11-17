/**
 * 核心下载线路。第三方加速只改变下载地址，不改变内容；安装前仍会用钉死的
 * SHA-256 校验，避免镜像返回旧包或被篡改的包。
 */
export interface MirrorPreset {
  value: string;
  label: string;
}

export const MIRROR_PRESETS: MirrorPreset[] = [
  { value: "", label: "直连 GitHub（默认）" },
  { value: "https://gh-proxy.com/", label: "gh-proxy.com（国内加速）" },
  { value: "https://ghproxy.vip/", label: "ghproxy.vip（国内加速）" },
];

/** 把加速前缀拼到原始下载地址前；空前缀表示直连。 */
export function withDownloadMirror(url: string, mirror?: string | null): string {
  const prefix = (mirror || "").trim();
  if (!prefix) return url;
  if (!/^https?:\/\//i.test(prefix)) {
    throw new Error("下载加速地址需以 http:// 或 https:// 开头");
  }
  return `${prefix.replace(/\/+$/, "")}/${url}`;
}
