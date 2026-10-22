import type { ChatConfig, ImageApiMode, ImageConfig, ImageModelConfig, ResolvedImageApiMode } from "../types";

export const IMAGE_API_LABELS: Record<ImageApiMode, string> = {
  auto: "自动识别",
  images: "Images · 标准图像接口",
  chat: "Chat · 多模态对话出图",
  gemini: "Gemini · 原生接口",
};

/** 模型名只能用于预判，网关别名由用户手动覆盖；不试发额外生图请求。 */
export function inferImageApiMode(model: string, baseUrl: string): ResolvedImageApiMode {
  const id = model.trim().toLowerCase();
  if (/gpt[-_]image|dall[-_]?e/.test(id)) return "images";
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "generativelanguage.googleapis.com" || /:generateContent(?:\?|$)/i.test(url.pathname)) return "gemini";
    if (/\/chat\/completions\/?$/i.test(url.pathname)) return "chat";
    if (/\/images\/(?:generations|edits)\/?$/i.test(url.pathname)) return "images";
  } catch { /* 尚未填写完整地址时也可预览模型的预判类型。 */ }
  return /gemini|nano[-_ ]?banana/.test(id) ? "chat" : "images";
}

export function resolveImageApiMode(mode: ImageApiMode | undefined, model: string, baseUrl: string): ResolvedImageApiMode {
  if (!mode || mode === "auto") return inferImageApiMode(model, baseUrl);
  if (mode === "images" || mode === "chat" || mode === "gemini") return mode;
  throw new Error(`不支持的图像接口类型：${mode}`);
}

export function configuredImageModels(config: ImageConfig): ImageModelConfig[] {
  const seen = new Set<string>();
  const pool = (config.modelPool ?? []).flatMap((entry) => {
    const id = entry.id.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ ...entry, id, apiMode: entry.apiMode || "auto" }];
  });
  return pool.length ? pool : config.model.trim() ? [{ id: config.model.trim(), apiMode: config.apiMode || "auto" }] : [];
}

export function canEditImageModel(entry: ImageModelConfig): boolean {
  return entry.supportsEditing ?? !/dall[-_]?e/i.test(entry.id);
}

function sameService(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; }
  catch { return a.replace(/\/$/, "") === b.replace(/\/$/, ""); }
}

/** 同一连接已拉取的列表可直接用于选图像模型，无需再重复输入或拉取。 */
export function availableImageModelIds(config: ImageConfig, chat?: ChatConfig): string[] {
  const protocol = resolveImageApiMode(config.apiMode, config.model, config.baseUrl) === "gemini" ? "gemini" : "openai";
  const shared = chat && chat.protocol === protocol && chat.apiKey === config.apiKey && sameService(chat.baseUrl, config.baseUrl) ? chat.models : [];
  return [...new Set([...config.models, ...shared, ...configuredImageModels(config).map((entry) => entry.id)])];
}

export function imageModelConnection(config: ImageConfig, entry: ImageModelConfig) {
  const baseUrl = entry.baseUrl?.trim() || config.baseUrl.trim();
  const apiKey = entry.apiKey?.trim() || (sameService(baseUrl, config.baseUrl) ? config.apiKey.trim() : "");
  return { model: entry.id, baseUrl, apiKey, apiMode: resolveImageApiMode(entry.apiMode, entry.id, baseUrl), timeoutSecs: config.timeoutSecs };
}

export function defaultImageConnection(config: ImageConfig) {
  const entry = configuredImageModels(config).find((model) => model.id === config.model.trim())
    ?? { id: config.model.trim(), apiMode: config.apiMode || "auto" };
  return imageModelConnection(config, entry);
}

export function selectImageModel(config: ImageConfig, requested: unknown, pinned = ""): ImageModelConfig {
  const pool = configuredImageModels(config);
  if (requested !== undefined && typeof requested !== "string") throw new Error("生图模型 ID 必须是字符串");
  const id = (typeof requested === "string" ? requested.trim() : "") || pinned || (pool.some((entry) => entry.id === config.model.trim()) ? config.model.trim() : pool[0]?.id);
  if (pinned && id !== pinned) throw new Error(`当前会话已指定生图模型 ${pinned}，不能调用 ${id}`);
  const entry = pool.find((model) => model.id === id);
  if (!entry) throw new Error(`生图模型 ${id || "未指定"} 未启用，请在设置的模型池中添加或重新选择`);
  return entry;
}

export function imageModelInstructions(config: ImageConfig, pinned = ""): string {
  const pool = configuredImageModels(config);
  const catalog = pool.map((entry) => `- ${entry.id}（${IMAGE_API_LABELS[imageModelConnection(config, entry).apiMode]}；${canEditImageModel(entry) ? "可生图、输入多张参考图编辑/合成" : "仅文生图，不接受参考图片"}）${entry.description?.trim() ? `：${entry.description.trim()}` : ""}`).join("\n");
  return `图像工具失败时由你分析错误，自主决定重试同一模型、改用已启用且具有所需能力的模型，或说明不能继续。失败响应给出 failed_call_id 时，可调用 retry_image 保留原请求的完整指令、素材顺序和输出参数。不要盲目循环同一个永久性错误；用户固定模型时不得擅自换模型。\n可用生图模型：\n${catalog || "暂无，请先配置图像模型"}\n${pinned ? `用户为当前会话指定了 ${pinned}，所有图像调用必须使用该模型。` : "根据用户指定的模型或任务需求，从上述已启用模型中选择；用工具参数 model 提供准确的模型 ID，不要自行添加模型。用户未指定时优先选择适合任务的模型。"}\n需要分工时，可以先让不同模型分别生成部件，中间素材的工具参数 stage 使用 asset，prompt 只说明该部件的任务。等待工具返回实际结果图和图片 ID，再用支持编辑/合成的模型调用 edit_image，把这些结果图按顺序加入 source_image_ids 进行组合，stage 使用 final。独立部件可以在同一轮发起多个工具调用；有图片依赖的下一步必须等结果返回后再调用，不能编造尚未生成的图片 ID。不要把中间素材当作最终成果，合成后检查实际最终图片。`;
}
