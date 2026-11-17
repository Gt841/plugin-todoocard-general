/**
 * `.bin` 是上游转换器给出的 4bit/像素位图（528×792，行优先，高半字节在前），
 * 已经做过 TodooCard/T3 的面板校准（上下颠倒）。预览时把它翻回正向并映射到
 * 六色调色板，得到接近卡片实际显示的画面。
 */
export const PREVIEW_PALETTE: Record<number, [number, number, number]> = {
  0: [23, 23, 23],
  1: [247, 247, 242],
  2: [255, 206, 20],
  3: [228, 52, 58],
  4: [204, 204, 204],
  5: [45, 108, 223],
  6: [46, 158, 91],
  7: [204, 204, 204],
};

export function decodePayloadBin(
  base64: string,
  width: number,
  height: number,
  palette: Record<number, [number, number, number]> = PREVIEW_PALETTE,
): Uint8ClampedArray {
  const raw = typeof atob === "function"
    ? atob(base64)
    : Buffer.from(base64, "base64").toString("binary");
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const idx = srcY * width + x;
      const byte = raw.charCodeAt(idx >> 1);
      const code = (idx & 1) === 0 ? byte >> 4 : byte & 0x0f;
      const rgb = palette[code] || palette[7];
      const p = (y * width + x) * 4;
      out[p] = rgb[0];
      out[p + 1] = rgb[1];
      out[p + 2] = rgb[2];
      out[p + 3] = 255;
    }
  }
  return out;
}
