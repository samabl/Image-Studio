// ---------------------------------------------------------------------------
// 与 Rust 侧一一对应的类型定义（Rust 结构体统一 serde(rename_all="camelCase")）
// ---------------------------------------------------------------------------

export interface ChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** null = 不下发 temperature；新版推理模型普遍不支持该参数 */
  temperature: number | null;
  maxTokens: number;
  stream: boolean;
  timeoutSecs: number;
  models: string[];
}

export type ImageApiMode = "images" | "chat";

export interface ImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** images = /images/generations 与 /images/edits；chat = /chat/completions + modalities */
  apiMode: ImageApiMode;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  n: number;
  timeoutSecs: number;
  models: string[];
}

export interface LinkageConfig {
  enabled: boolean;
  useTools: boolean;
  autoOptimizePrompt: boolean;
  visionModel: string;
  optimizeSystemPrompt: string;
  reverseSystemPrompt: string;
}

export interface UiConfig {
  language: string;
  sendOnEnter: boolean;
}

export interface AppConfig {
  version: number;
  chat: ChatConfig;
  image: ImageConfig;
  linkage: LinkageConfig;
  ui: UiConfig;
}

export type GalleryKind = "generate" | "edit" | "mask" | "chat" | "import";

export interface GalleryItem {
  id: string;
  fileName: string;
  path: string;
  kind: GalleryKind;
  prompt: string;
  model: string;
  size: string;
  createdAt: number;
  parentId?: string | null;
  revisedPrompt?: string | null;
  dataUrl?: string | null;
}

export interface SaveMeta {
  kind: string;
  prompt: string;
  model: string;
  size: string;
  parentId?: string | null;
}

// ---------------------------------------------------------------------------
// 对话数据结构（仅前端使用）
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatAttachment {
  id: string;
  dataUrl: string;
  name?: string;
  /** 若来自图库则记录 id，便于联动编辑 */
  galleryId?: string;
}

export interface GeneratedRef {
  galleryId: string;
  path: string;
  dataUrl?: string;
  prompt: string;
  size?: string;
  model?: string;
}

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  attachments?: ChatAttachment[];
  images?: GeneratedRef[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** 等待工具执行中的占位状态 */
  pending?: boolean;
  error?: string;
  createdAt: number;
  model?: string;
  usage?: Record<string, unknown> | null;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 流式事件（对应 Rust 的 ChatEvent）
// ---------------------------------------------------------------------------

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCalls"; calls: ToolCall[] }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// 图像请求
// ---------------------------------------------------------------------------

export interface ImageRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiMode?: ImageApiMode;
  prompt: string;
  images?: string[];
  mask?: string | null;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  extraBody?: Record<string, unknown> | null;
  timeoutSecs?: number;
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number | null;
  maxTokens?: number | null;
  tools?: unknown[] | null;
  toolChoice?: unknown;
  extraBody?: Record<string, unknown> | null;
  timeoutSecs?: number | null;
}
