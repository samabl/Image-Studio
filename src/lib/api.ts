import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  ChatEvent,
  ChatRequest,
  GalleryItem,
  ImageRequest,
  SaveMeta,
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
export const dataDir = () => call<string>("data_dir");

// --- 状态存取 -------------------------------------------------------------

export const loadState = (key: string) => call<string | null>("load_state", { key });
export const saveState = (key: string, value: string) => call<void>("save_state", { key, value });

// --- 模型 -----------------------------------------------------------------

export const listModels = (baseUrl: string, apiKey: string) =>
  call<string[]>("list_models", { baseUrl, apiKey });

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

// --- 图像 -----------------------------------------------------------------

export const generateImage = (request: ImageRequest, parentId?: string | null) =>
  call<GalleryItem[]>("generate_image", { request, parentId: parentId ?? null });

export const saveDataUrl = (dataUrl: string, meta: SaveMeta) =>
  call<GalleryItem[]>("save_data_url", { dataUrl, meta });

// --- 图库 -----------------------------------------------------------------

export const galleryList = () => call<GalleryItem[]>("gallery_list");
export const galleryDelete = (ids: string[]) => call<number>("gallery_delete", { ids });
export const galleryClear = () => call<number>("gallery_clear");
export const galleryExport = (id: string, target: string) =>
  call<string>("gallery_export", { id, target });
export const readImageDataUrl = (path: string) => call<string>("read_image_data_url", { path });
export const importImageFile = (path: string) => call<string>("import_image_file", { path });
