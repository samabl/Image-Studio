import workerSource from "./codeWorker.js?raw";
import type { CodeRuntimeConfig } from "../types";
import type { ImageSource } from "./chat";

export function codeRuntimeSettings(config?: Partial<CodeRuntimeConfig>): CodeRuntimeConfig {
  const timeout = config?.timeoutSecs;
  return { enabled: config?.enabled ?? false, timeoutSecs: typeof timeout === "number" && Number.isFinite(timeout) ? Math.max(1, Math.min(30, Math.floor(timeout))) : 10 };
}

export const codeImageInstructions = `你可以使用 edit_image_code 在内置 JavaScript 运行时修改实际图片。适合精确裁剪、缩放、翻转、旋转、调色、拼接、透明叠加、文字或几何绘制；复杂语义重绘仍使用图像模型。
source_image_ids 选择全部输入并指定顺序。code 是 async 函数体，输入 images 为按顺序排列的 {width,height,data:Uint8ClampedArray RGBA}；最后必须 return 一张图像对象或 1–4 张对象数组。像素通道范围 0–255。
内置 image SDK：create(w,h,rgba?)、clone(src)、crop(src,x,y,w,h)、resize(src,w,h)（双线性）、flip(src,horizontal=true,vertical=false)、rotate(src,quarterTurns=1)（顺时针90度倍数）、map(src,(r,g,b,a,x,y)=>[r,g,b,a]) 返回新图；fill(src,rgba,x=0,y=0,w=src.width,h=src.height)、composite(base,overlay,x=0,y=0,opacity=1) 会修改并返回基底。
image.supportsCanvas 为 true 时可使用 image.canvas(src) 获得 OffscreenCanvas，用 getContext('2d') 绘图或 fillText，再 image.fromCanvas(canvas) 转回图像。否则用像素 SDK。不支持 Python、npm、DOM、文件、网络或应用接口。可用 log(...values) 记录简短日志。
图片最大边长4096，一次累计画布预算约5000万像素；最多30秒（实际以用户设置为准）。不创建无意义的巨大数组或无限循环。保留用户指定的不变部分，不擅自改变尺寸。代码成功返回实际图片后才能声称完成。
示例：const out=image.clone(images[0]); image.fill(out,[255,0,0,255],10,10,100,40); log('已绘制矩形'); return out;`;

export const codeImageTool = {
  type: "function",
  function: {
    name: "edit_image_code",
    description: "通过内置隔离 JavaScript 运行时对已有图片进行精确的像素、裁剪、调色、合成或绘制处理，不调用图像生成 API。返回实际 PNG 图片。",
    parameters: {
      type: "object",
      properties: {
        source_image_ids: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" }, description: "全部输入图片的准确 ID，按代码 images 数组的使用顺序排列，不重复。" },
        description: { type: "string", description: "说明本次处理和保持不变的内容，忠实保留用户最新要求。" },
        code: { type: "string", description: "JavaScript async 函数体，使用 images/image/log，必须 return 实际图像对象或对象数组，不含 Markdown 代码围栏。" },
        stage: { type: "string", enum: ["asset", "final"], description: "asset 中间素材；final 最终结果（默认）。" },
      },
      required: ["source_image_ids", "description", "code"],
    },
  },
};

interface Pixels { width: number; height: number; data: Uint8ClampedArray; }
export interface CodeImageResult { dataUrls: string[]; sizes: string[]; logs: string[]; elapsedMs: number; }

function checkSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 16 * 1024 * 1024) {
    throw new Error("代码图像尺寸超限：最大边长 4096");
  }
}

export function validateCodeOutputs(value: unknown): Pixels[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("代码必须返回 1–4 张图片");
  let total = 0;
  return value.map((source) => {
    if (!source || typeof source !== "object") throw new Error("代码返回的图像无效");
    checkSize(source.width, source.height);
    if (!(source.data instanceof Uint8ClampedArray) || source.data.length !== source.width * source.height * 4) throw new Error("代码返回的 RGBA 像素无效");
    total += source.width * source.height;
    if (total > 48 * 1024 * 1024) throw new Error("代码输出超过像素预算");
    return { width: source.width, height: source.height, data: source.data };
  });
}

/** 固定 opaque-origin iframe + CSP + Worker；不在主窗口 eval 任何模型代码。 */
export function startCodeEdit(sources: ImageSource[], code: string, config?: Partial<CodeRuntimeConfig>) {
  const options = codeRuntimeSettings(config);
  const id = `code_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let stopped = false;
  let finished = false;
  let frame: HTMLIFrameElement | null = null;
  let rejectCancel: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancel = reject; });
  const cleanups: (() => void)[] = [];
  const stop = (message: string) => {
    if (finished || stopped) return;
    stopped = true;
    rejectCancel(new Error(message));
  };
  const timer = setTimeout(() => stop(`代码执行超时（${options.timeoutSecs} 秒）`), options.timeoutSecs * 1000);
  const decode = async (source: ImageSource): Promise<Pixels> => {
    if (!source.dataUrl?.startsWith("data:image/")) throw new Error("代码编辑需要可读取的实际图片");
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve(); img.onerror = () => reject(new Error("无法读取代码编辑的输入图片"));
      cleanups.push(() => { img.onload = null; img.onerror = null; img.src = ""; });
      img.src = source.dataUrl!;
    });
    await Promise.race([loaded, cancellation]);
    checkSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("无法创建图像画布");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = { width: canvas.width, height: canvas.height, data };
    canvas.width = 0; canvas.height = 0;
    return result;
  };
  const work = async (): Promise<CodeImageResult> => {
    if (!code.trim() || code.length > 40000) throw new Error("代码不能为空且最多 40000 字符");
    if (!sources.length || sources.length > 4) throw new Error("一次代码编辑需要 1–4 张输入图片");
    const images: Pixels[] = [];
    let pixels = 0;
    for (const source of sources) {
      if (stopped) throw new Error("已停止代码执行");
      const image = await decode(source);
      pixels += image.width * image.height;
      if (pixels > 48 * 1024 * 1024) throw new Error("输入图片超过像素预算");
      images.push(image);
    }
    if (stopped) throw new Error("已停止代码执行");
    const response = new Promise<{ images: unknown; logs?: unknown; elapsedMs?: unknown }>((resolve, reject) => {
      let started = false;
      const iframe = document.createElement("iframe");
      frame = iframe;
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.hidden = true;
      iframe.src = new URL("runtime/sandbox.html", document.baseURI).href;
      const receive = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow || stopped || !event.data) return;
        const data = event.data;
        if (data.type === "ready" && !started) {
          started = true;
          try {
            iframe.contentWindow?.postMessage({ type: "execute", id, source: workerSource.replace("/*__CHAT_CODE__*/", () => code), images }, "*", images.map((image) => image.data.buffer));
          } catch {
            reject(new Error("无法启动隔离代码运行时"));
          }
          return;
        }
        if (data.id !== id) return;
        if (data.type === "result") resolve(data);
        else if (data.type === "error") reject(new Error(typeof data.message === "string" ? data.message.slice(0, 2000) : "代码执行失败"));
      };
      window.addEventListener("message", receive);
      cleanups.push(() => window.removeEventListener("message", receive));
      iframe.onerror = () => reject(new Error("无法加载隔离代码运行时"));
      document.body.appendChild(iframe);
    });
    const result = await Promise.race([response, cancellation]);
    const outputs = validateCodeOutputs(result.images);
    const dataUrls = outputs.map((output) => {
      if (stopped) throw new Error("已停止代码执行");
      const canvas = document.createElement("canvas");
      canvas.width = output.width; canvas.height = output.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法编码代码图像");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(output.data), output.width, output.height), 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      canvas.width = 0; canvas.height = 0;
      return dataUrl;
    });
    return { dataUrls, sizes: outputs.map((output) => `${output.width}x${output.height}`),
      logs: Array.isArray(result.logs) ? result.logs.filter((log): log is string => typeof log === "string").slice(0, 40).map((log) => log.slice(0, 500)) : [],
      elapsedMs: typeof result.elapsedMs === "number" && Number.isFinite(result.elapsedMs) ? Math.max(0, result.elapsedMs) : 0,
    };
  };
  const promise = Promise.race([work(), cancellation]).finally(() => {
    finished = true;
    clearTimeout(timer);
    if (frame) { frame.contentWindow?.postMessage({ type: "cancel", id }, "*"); frame.remove(); frame = null; }
    for (const cleanup of cleanups) cleanup();
  });
  return { promise, cancel: () => stop("已停止代码执行") };
}
