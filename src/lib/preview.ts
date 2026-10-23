export interface PreviewPoint { x: number; y: number }
export interface PreviewView extends PreviewPoint { scale: number }
export interface PreviewBounds { width: number; height: number; imageWidth: number; imageHeight: number }

export const MIN_PREVIEW_SCALE = 1;
export const MAX_PREVIEW_SCALE = 8;
export const FIT_PREVIEW: PreviewView = { scale: 1, x: 0, y: 0 };

export function fitPreview(width: number, height: number, imageWidth: number, imageHeight: number): PreviewBounds {
  const ratio = imageWidth > 0 && imageHeight > 0
    ? Math.max(0, Math.min(1, (width - 24) / imageWidth, (height - 24) / imageHeight)) : 0;
  return { width, height, imageWidth: imageWidth * ratio, imageHeight: imageHeight * ratio };
}

/** 限制缩放和拖动，避免把图片拖出预览区。 */
export function clampPreview(view: PreviewView, bounds: PreviewBounds): PreviewView {
  const scale = Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, view.scale));
  const maxX = Math.max(0, (bounds.imageWidth * scale - bounds.width) / 2);
  const maxY = Math.max(0, (bounds.imageHeight * scale - bounds.height) / 2);
  return { scale, x: Math.max(-maxX, Math.min(maxX, view.x)), y: Math.max(-maxY, Math.min(maxY, view.y)) };
}

/** 保持鼠标/双指中心下的像素不变；afterAnchor 支持捏合时同时平移。 */
export function zoomPreview(view: PreviewView, nextScale: number, anchor: PreviewPoint, bounds: PreviewBounds, afterAnchor = anchor): PreviewView {
  const scale = Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, nextScale));
  const ratio = scale / view.scale;
  return clampPreview({ scale, x: afterAnchor.x - (anchor.x - view.x) * ratio, y: afterAnchor.y - (anchor.y - view.y) * ratio }, bounds);
}
