import { PANEL_HEIGHT, PANEL_WIDTH } from "../types";

/**
 * 上游转换器固定按 528×792 做 cover（等比放大后居中裁切）。如果直接把原图交给它，
 * 用户在“原始图”里看到的完整画面与卡片上实际显示的局部画面会不一致。
 *
 * 这里先把用户选定的 2:3 构图裁好，再交给上游；只要输入已经是 2:3，上游的 cover
 * 就不会再产生额外裁切。旋转也在这里一并烘焙，避免“先裁再转”与“先转再裁”的差异。
 */
export interface CropInput {
  sourceWidth: number;
  sourceHeight: number;
  /** 是否先顺时针旋转 90°，按旋转后的图像计算取景。 */
  rotated?: boolean;
  /** 1 表示刚好铺满取景框；越大取景越紧。 */
  zoom?: number;
  /** 取景中心在（旋转后）图像中的归一化坐标。 */
  centerX?: number;
  centerY?: number;
  /** 取景框宽高比，默认面板的 528:792。 */
  frameAspect?: number;
}

export interface CropGeometry {
  effectiveWidth: number;
  effectiveHeight: number;
  cropWidth: number;
  cropHeight: number;
  centerX: number;
  centerY: number;
  sourceX: number;
  sourceY: number;
  minCenterX: number;
  maxCenterX: number;
  minCenterY: number;
  maxCenterY: number;
}

const DEFAULT_ASPECT = PANEL_WIDTH / PANEL_HEIGHT;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function computeCropGeometry(input: CropInput): CropGeometry {
  const effectiveWidth = input.rotated ? input.sourceHeight : input.sourceWidth;
  const effectiveHeight = input.rotated ? input.sourceWidth : input.sourceHeight;
  if (!(effectiveWidth > 0) || !(effectiveHeight > 0)) throw new Error("图片尺寸无效");

  const aspect = input.frameAspect && input.frameAspect > 0 ? input.frameAspect : DEFAULT_ASPECT;
  const zoom = Math.max(1, input.zoom ?? 1);
  let cropWidth: number;
  let cropHeight: number;
  if (effectiveWidth / effectiveHeight > aspect) {
    cropHeight = effectiveHeight / zoom;
    cropWidth = cropHeight * aspect;
  } else {
    cropWidth = effectiveWidth / zoom;
    cropHeight = cropWidth / aspect;
  }
  // 浮点误差兜底，保证取景框不会超过图像。
  cropWidth = Math.min(cropWidth, effectiveWidth);
  cropHeight = Math.min(cropHeight, effectiveHeight);

  const minCenterX = cropWidth / (2 * effectiveWidth);
  const maxCenterX = 1 - minCenterX;
  const minCenterY = cropHeight / (2 * effectiveHeight);
  const maxCenterY = 1 - minCenterY;
  const centerX = clamp(input.centerX ?? 0.5, minCenterX, maxCenterX);
  const centerY = clamp(input.centerY ?? 0.5, minCenterY, maxCenterY);

  return {
    effectiveWidth,
    effectiveHeight,
    cropWidth,
    cropHeight,
    centerX,
    centerY,
    sourceX: centerX * effectiveWidth - cropWidth / 2,
    sourceY: centerY * effectiveHeight - cropHeight / 2,
    minCenterX,
    maxCenterX,
    minCenterY,
    maxCenterY,
  };
}

/** 把取景框内的拖动位移（显示像素）换算成新的归一化中心，并夹在图像边界内。 */
export function panCropCenter(
  geometry: CropGeometry,
  deltaX: number,
  deltaY: number,
  frameWidth: number,
  frameHeight: number,
): { centerX: number; centerY: number } {
  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    return { centerX: geometry.centerX, centerY: geometry.centerY };
  }
  const dx = (deltaX * (geometry.cropWidth / frameWidth)) / geometry.effectiveWidth;
  const dy = (deltaY * (geometry.cropHeight / frameHeight)) / geometry.effectiveHeight;
  return {
    centerX: clamp(geometry.centerX - dx, geometry.minCenterX, geometry.maxCenterX),
    centerY: clamp(geometry.centerY - dy, geometry.minCenterY, geometry.maxCenterY),
  };
}
