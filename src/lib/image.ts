import type { ChatAttachment } from "../types";

/** 送去模型前把超长边压到这个尺寸，既省流量也避开多数网关的体积上限。 */
export const MAX_UPLOAD_SIDE = 2048;

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}

/** File -> data URL，同时按 MAX_UPLOAD_SIDE 等比压缩。 */
export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const raw = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("读取文件失败"));
    fr.readAsDataURL(file);
  });
  const dataUrl = await downscaleDataUrl(raw, MAX_UPLOAD_SIDE);
  return { id: uid("att"), dataUrl, name: file.name };
}

/** 等比缩放 data URL；已经足够小则原样返回。 */
export async function downscaleDataUrl(
  dataUrl: string,
  maxSide: number,
  mime = "image/png",
  quality = 0.92,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  if (longSide <= maxSide) return dataUrl;

  const scale = maxSide / longSide;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  // 带透明通道的图必须留 PNG，否则透明区会变黑
  const hasAlpha = mime === "image/png";
  return canvas.toDataURL(hasAlpha ? "image/png" : mime, hasAlpha ? undefined : quality);
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(meta)?.[1] ?? "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  const img = await loadImage(dataUrl);
  return { w: img.naturalWidth, h: img.naturalHeight };
}

// ---------------------------------------------------------------------------
// 蒙版
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** 一笔涂鸦；坐标使用 0~1 归一化，便于任意分辨率重绘。 */
export interface Stroke {
  size: number;
  points: Point[];
}

/**
 * 把涂鸦渲染成 API 需要的蒙版 PNG。
 *
 * 语义遵循 OpenAI：**透明区域 = 需要被编辑的区域**。
 * 所以底色铺满不透明黑，再用 destination-out 把涂过的地方挖成透明。
 */
export async function renderMask(
  sourceDataUrl: string,
  strokes: Stroke[],
): Promise<string | null> {
  if (strokes.length === 0) return null;
  const img = await loadImage(sourceDataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,1)";

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length === 0) continue;
    const lineWidth = Math.max(1, stroke.size * Math.min(w, h));
    ctx.lineWidth = lineWidth;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * w, pts[0].y * h, lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

/** 图层模式：把参考图按 "contain" 方式画进结果图，用于多图合成。 */
export async function composeSideBySide(
  refs: string[],
  mime = "image/png",
): Promise<string | null> {
  if (refs.length === 0) return null;
  const imgs = await Promise.all(refs.map(loadImage));
  const totalW = imgs.reduce((sum, i) => sum + i.naturalWidth, 0);
  const maxH = Math.max(...imgs.map((i) => i.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = totalW;
  canvas.height = maxH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let x = 0;
  for (const img of imgs) {
    ctx.drawImage(img, x, 0);
    x += img.naturalWidth;
  }
  return canvas.toDataURL(mime);
}
