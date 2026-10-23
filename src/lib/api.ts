import { Channel, invoke } from "@tauri-apps/api/core";
import { isAndroid } from "./platform";
import type {
  AppConfig,
  ChatProtocol,
  ChatEvent,
  ChatRequest,
  GalleryItem,
  ImageRequest,
  SaveMeta,
  ThemeMode,
} from "../types";

/** 统一的调用错误：把 Rust 侧字符串错误包成 Error，便于 `catch (e) { e.message }`。 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : String(err));
  }
}

// --- 配置 -----------------------------------------------------------------

export const getConfig = () => call<AppConfig>("get_config");
export const saveConfig = (config: AppConfig) => call<AppConfig>("save_config", { config });
export const resetConfig = () => call<AppConfig>("reset_config");
export const setNativeTheme = (theme: "light" | "dark", mode: ThemeMode) => call<void>("set_native_theme", { theme, mode });
export const dataDir = () => call<string>("data_dir");

// --- 状态存取 -------------------------------------------------------------

export const loadState = (key: string) => call<string | null>("load_state", { key });
export const saveState = (key: string, value: string) => call<void>("save_state", { key, value });

/** Android 用同一个原生任务覆盖整个工作流，生图与回图检查之间也保持运行。 */
export function startBackgroundTask() {
  if (!isAndroid) return null;
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const ready = call<void>("background_task_start", { taskId });
  return {
    ready,
    finish: () => ready.then(() => call<void>("background_task_finish", { taskId })).catch(() => undefined),
  };
}

export const backgroundTaskStatus = () => call<{ batteryOptimizationIgnored: boolean; notificationsEnabled: boolean }>("background_task_status");
export const configureBackgroundTasks = () => call<void>("background_task_configure");
export const saveImageToAlbum = (dataUrl: string, fileName: string) => call<string>("save_image_to_album", { dataUrl, fileName });

// --- 模型 -----------------------------------------------------------------

export const listModels = (baseUrl: string, apiKey: string, protocol: ChatProtocol = "openai") =>
  call<string[]>("list_models", { baseUrl, apiKey, protocol });

// --- 对话 -----------------------------------------------------------------

/**
 * 发起流式对话。返回 streamId 与取消函数。
 * 事件通过 Tauri Channel 推过来，组件卸载时务必调用 cancel。
 */
export function chatStream(
  request: ChatRequest,
  onEvent: (ev: ChatEvent) => void,
): { streamId: string; cancel: () => void } {
  const streamId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  void call<void>("chat_stream", { streamId, request, onEvent: channel }).catch((err: Error) => {
    onEvent({ type: "error", message: err.message });
  });
  return {
    streamId,
    cancel: () => {
      void call<void>("chat_cancel", { streamId }).catch(() => undefined);
    },
  };
}

export const chatOnce = (request: ChatRequest) => call<string>("chat_once", { request });

export function cancellableText(request: ChatRequest) {
  let cancel = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || !text.trim()) reject(new Error(error || "模型返回了空内容"));
      else resolve(text.trim());
    };
    const timer = setTimeout(() => { task.cancel(); finish("等待响应超时"); }, ((request.timeoutSecs ?? 300) + 60) * 1000);
    const task = chatStream({ ...request, stream: false }, (event) => {
      if (settled) return;
      if (event.type === "delta") text += event.text;
      else if (event.type === "error") finish(event.message);
      else if (event.type === "done") finish();
    });
    cancel = () => { task.cancel(); finish("已停止"); };
  });
  return { promise, cancel: () => cancel() };
}

// --- 图像 -----------------------------------------------------------------

export const generateImage = (request: ImageRequest, parentId?: string | null, requestId?: string) =>
  call<GalleryItem[]>("generate_image", { request, parentId: parentId ?? null, requestId: requestId ?? null });

export function cancellableImage(request: ImageRequest, parentId?: string | null) {
  const requestId = `image_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    promise: generateImage(request, parentId, requestId),
    cancel: () => { void call<void>("chat_cancel", { streamId: requestId }).catch(() => undefined); },
  };
}

export const saveDataUrl = (dataUrl: string, meta: SaveMeta) =>
  call<GalleryItem[]>("save_data_url", { dataUrl, meta });

export const saveImageOutputs = (dataUrls: string[], meta: SaveMeta) =>
  call<GalleryItem[]>("save_image_outputs", { dataUrls, meta });

// --- 图库 -----------------------------------------------------------------

export const galleryList = () => call<GalleryItem[]>("gallery_list");
export const galleryArchive = (item: GalleryItem) => call<GalleryItem>("gallery_archive", { item });
export const galleryDelete = (ids: string[]) => call<number>("gallery_delete", { ids });
export const galleryClear = () => call<number>("gallery_clear");
export const galleryExport = (id: string, target: string) =>
  call<string>("gallery_export", { id, target });
export const readImageDataUrl = (path: string) => call<string>("read_image_data_url", { path });
export const importImageFile = (path: string) => call<string>("import_image_file", { path });
