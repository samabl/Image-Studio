// ---------------------------------------------------------------------------
// 与 Rust 侧一一对应的类型定义（Rust 结构体统一 serde(rename_all="camelCase")）
// ---------------------------------------------------------------------------

export type ChatProtocol = "openai" | "anthropic" | "gemini";

export interface ChatConfig {
  protocol: ChatProtocol;
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

export type ImageApiMode = "auto" | "images" | "chat" | "gemini";
export type ResolvedImageApiMode = Exclude<ImageApiMode, "auto">;

export interface ImageModelConfig {
  id: string;
  apiMode: ImageApiMode;
  description?: string;
  supportsEditing?: boolean;
  /** 留空沿用图像连接；不同服务地址需填写该服务的密钥。 */
  baseUrl?: string;
  apiKey?: string;
}

export interface ImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** images = 图像接口；chat = 兼容对话出图；gemini = 原生 GenerateContent */
  apiMode: ImageApiMode;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  n: number;
  timeoutSecs: number;
  models: string[];
  /** 供 Chat 选择的模型池；旧配置/空池沿用默认模型。 */
  modelPool?: ImageModelConfig[];
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
  providerData?: Record<string, unknown>;
  /** 本地展示元数据，不透传协议；保留实际输入顺序与完整发送指令。 */
  sourceLabels?: string[];
  sentPrompt?: string;
  imageModel?: string;
  imageApiMode?: ResolvedImageApiMode;
  imageStage?: "asset" | "final";
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
  draftText?: string;
  draftAtts?: ChatAttachment[];
  /** 空值表示让 Chat 从已启用的模型池中选择。 */
  imageModel?: string;
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
  imageLabels?: string[];
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
  protocol?: ChatProtocol;
  stream?: boolean;
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
