"use strict";
// 这段源码作为文本放入隔离页的 Blob Worker；不引用任何应用模块。
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "indexedDB", "caches", "navigator", "BroadcastChannel", "RTCPeerConnection"]) {
  try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch { /* CSP 和 opaque origin 是第二道隔离。 */ }
}
const MAX_SIDE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_ALLOCATED_PIXELS = 48 * 1024 * 1024;
let allocated = 0;
function reserve(width, height) {
  dimensions(width, height);
  allocated += width * height;
  if (allocated > MAX_ALLOCATED_PIXELS) throw new Error("本次图像分配超过上限，请减少中间画布");
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error("图片尺寸必须是 1–4096 的整数");
  }
}
function valid(source) {
  if (!source || typeof source !== "object") throw new Error("请返回图像对象");
  dimensions(source.width, source.height);
  if (!(source.data instanceof Uint8ClampedArray) || source.data.length !== source.width * source.height * 4) throw new Error("图像 data 必须是正确长度的 Uint8ClampedArray RGBA");
  return source;
}
function color(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4 || value.some((v) => !Number.isFinite(v))) throw new Error("颜色使用 [r,g,b,a]，范围 0–255");
  return [value[0], value[1], value[2], value[3] ?? 255];
}
function create(width, height, background) {
  reserve(width, height);
  const result = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  if (background) fill(result, background);
  return result;
}
function clone(source) {
  valid(source);
  const result = create(source.width, source.height);
  result.data.set(source.data);
  return result;
}
function fill(source, rgba, x = 0, y = 0, width = source.width, height = source.height) {
  valid(source);
  if (![x, y, width, height].every(Number.isFinite)) throw new Error("矩形参数必须是有限数值");
  const c = color(rgba);
  for (let row = Math.max(0, Math.floor(y)); row < Math.min(source.height, y + height); row++) {
    for (let col = Math.max(0, Math.floor(x)); col < Math.min(source.width, x + width); col++) {
      const i = (row * source.width + col) * 4;
      source.data[i] = c[0]; source.data[i + 1] = c[1]; source.data[i + 2] = c[2]; source.data[i + 3] = c[3];
    }
  }
  return source;
}
function crop(source, x, y, width, height) {
  valid(source);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("裁剪位置使用整数");
  const result = create(width, height);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= source.height) continue;
    const left = Math.max(0, x), right = Math.min(source.width, x + width);
    if (right <= left) continue;
    result.data.set(source.data.subarray((sy * source.width + left) * 4, (sy * source.width + right) * 4), (row * width + left - x) * 4);
  }
  return result;
}
function resize(source, width, height) {
  valid(source);
  const result = create(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(source.height - 1, (y + 0.5) * source.height / height - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(source.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(source.width - 1, (x + 0.5) * source.width / width - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(source.width - 1, x0 + 1), fx = sx - x0;
      // 预乘 alpha 插值，避免透明图缩放后出现彩边。
      const positions = [(y0 * source.width + x0) * 4, (y0 * source.width + x1) * 4, (y1 * source.width + x0) * 4, (y1 * source.width + x1) * 4];
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const alpha = positions.reduce((sum, pos, i) => sum + source.data[pos + 3] * weights[i], 0);
      const dst = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) result.data[dst + c] = alpha ? positions.reduce((sum, pos, i) => sum + source.data[pos + c] * source.data[pos + 3] * weights[i], 0) / alpha : 0;
      result.data[dst + 3] = alpha;
    }
  }
  return result;
}
function composite(base, overlay, x = 0, y = 0, opacity = 1) {
  valid(base); valid(overlay);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("合成位置使用整数，透明度为 0–1");
  if (base.data.buffer === overlay.data.buffer) overlay = clone(overlay);
  for (let oy = Math.max(0, -y); oy < Math.min(overlay.height, base.height - y); oy++) {
    for (let ox = Math.max(0, -x); ox < Math.min(overlay.width, base.width - x); ox++) {
      const src = (oy * overlay.width + ox) * 4, dst = ((oy + y) * base.width + ox + x) * 4;
      const sa = overlay.data[src + 3] / 255 * opacity, da = base.data[dst + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) base.data[dst + c] = outA ? (overlay.data[src + c] * sa + base.data[dst + c] * da * (1 - sa)) / outA : 0;
      base.data[dst + 3] = outA * 255;
    }
  }
  return base;
}
function map(source, fn) {
  valid(source);
  if (typeof fn !== "function") throw new Error("map 需要像素处理函数");
  const result = create(source.width, source.height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const i = (y * source.width + x) * 4;
    const rgba = color(fn(source.data[i], source.data[i + 1], source.data[i + 2], source.data[i + 3], x, y));
    result.data.set(rgba, i);
  }
  return result;
}
function flip(source, horizontal = true, vertical = false) {
  valid(source);
  const result = create(source.width, source.height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const i = (y * source.width + x) * 4;
    const j = ((vertical ? source.height - 1 - y : y) * source.width + (horizontal ? source.width - 1 - x : x)) * 4;
    result.data.set(source.data.subarray(i, i + 4), j);
  }
  return result;
}
function rotate(source, quarterTurns = 1) {
  valid(source);
  if (!Number.isInteger(quarterTurns)) throw new Error("旋转使用 90° 的整数倍");
  const turns = (quarterTurns % 4 + 4) % 4;
  const result = create(turns % 2 ? source.height : source.width, turns % 2 ? source.width : source.height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const rx = turns === 1 ? source.height - 1 - y : turns === 2 ? source.width - 1 - x : turns === 3 ? y : x;
    const ry = turns === 1 ? x : turns === 2 ? source.height - 1 - y : turns === 3 ? source.width - 1 - x : y;
    const i = (y * source.width + x) * 4;
    result.data.set(source.data.subarray(i, i + 4), (ry * result.width + rx) * 4);
  }
  return result;
}
function canvas(source) {
  valid(source);
  if (typeof OffscreenCanvas === "undefined") throw new Error("此 WebView 不支持 OffscreenCanvas，请使用 image 的像素方法");
  reserve(source.width, source.height);
  const result = new OffscreenCanvas(source.width, source.height);
  const ctx = result.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(source.data), source.width, source.height), 0, 0);
  return result;
}
function fromCanvas(source) {
  dimensions(source.width, source.height);
  const ctx = source.getContext("2d");
  if (!ctx) throw new Error("无法读取 2D 画布");
  const result = create(source.width, source.height);
  result.data.set(ctx.getImageData(0, 0, source.width, source.height).data);
  return result;
}
const image = Object.freeze({ create, clone, crop, resize, composite, fill, map, flip, rotate, canvas, fromCanvas,
  supportsCanvas: typeof OffscreenCanvas !== "undefined" });
const logs = [];
const log = (...values) => {
  if (logs.length >= 40) return;
  logs.push(values.map((value) => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  }).join(" ").slice(0, 500));
};
globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
const send = globalThis.postMessage.bind(globalThis);
globalThis.onmessage = async ({ data }) => {
  const started = performance.now();
  try {
    const images = data.images.map(valid);
    allocated = images.reduce((total, source) => total + source.width * source.height, 0);
    if (allocated > MAX_ALLOCATED_PIXELS) throw new Error("输入图片超过像素预算");
    const execute = async (images, image, log) => {
/*__CHAT_CODE__*/
    };
    const value = await execute(images, image, log);
    const results = (Array.isArray(value) ? value : [value]).map(valid);
    if (!results.length || results.length > 4) throw new Error("必须返回 1–4 张实际图片");
    if (results.reduce((total, result) => total + result.width * result.height, 0) > MAX_ALLOCATED_PIXELS) throw new Error("代码输出超过像素预算");
    // 只返回允许的像素字段，剥离任意模型代码附加的对象或方法。
    const outputs = results.map((result) => ({ width: result.width, height: result.height, data: new Uint8ClampedArray(result.data) }));
    send({ type: "result", id: data.id, images: outputs, logs, elapsedMs: Math.round(performance.now() - started) }, outputs.map((output) => output.data.buffer));
  } catch (error) {
    send({ type: "error", id: data.id, message: error instanceof Error ? error.message : String(error), logs });
  }
};
