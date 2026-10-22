import type { ChatAttachment, ChatMessage } from "../types";

export interface ImageSource {
  id: string;
  label: string;
  dataUrl?: string;
  path?: string;
  galleryId?: string;
}

export function attachmentLabel(a: ChatAttachment, index: number): string {
  return `素材 ${index + 1}${a.name ? `：${a.name}` : ""}（图片 ID：${a.id}）`;
}

export function imageSources(m: ChatMessage): ImageSource[] {
  return [
    ...(m.attachments ?? []).map((a, i) => ({ ...a, label: attachmentLabel(a, i) })),
    ...(m.images ?? []).map((image, i) => ({ ...image, id: `image_${image.galleryId}`, label: `结果图 ${i + 1}（图片 ID：image_${image.galleryId}）` })),
  ];
}

export function selectImageSources(messages: ChatMessage[], ids?: unknown): ImageSource[] {
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
      throw new Error("图片 ID 必须是按使用顺序排列、没有重复的字符串数组");
    }
    const catalog = new Map(messages.flatMap(imageSources).map((image) => [image.id, image]));
    return ids.map((id) => {
      const image = catalog.get(id);
      if (!image) throw new Error(`找不到图片 ID：${id}`);
      return image;
    });
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const sources = imageSources(messages[i]);
    if (sources.length) return sources;
  }
  return [];
}

export function userImageContent(text: string, images: ImageSource[]): unknown[] {
  return [
    { type: "text", text },
    ...images.flatMap((image) => [
      { type: "text", text: image.label },
      { type: "image_url", image_url: { url: image.dataUrl } },
    ]),
  ];
}

export function toApiMessages(m: ChatMessage): unknown[] {
  if (m.role === "tool") {
    const tool = { role: "tool", tool_call_id: m.toolCallId, content: m.content || "已完成" };
    const images = imageSources(m).filter((image) => image.dataUrl);
    return images.length ? [tool, { role: "user", content: userImageContent("以下是图像工具实际输出，请检查是否满足我的要求。", images) }] : [tool];
  }
  if (m.role === "assistant") {
    return [{ role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? {
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments }, ...(tc.providerData ? { provider_data: tc.providerData } : {}) })),
    } : {}) }];
  }
  const images = imageSources(m);
  return [{ role: "user", content: images.length ? userImageContent(m.content, images) : m.content }];
}

export function conversationMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  let feedback: unknown[] = [];
  for (const message of messages) {
    if (message.role !== "tool" && feedback.length) { out.push(...feedback); feedback = []; }
    const [first, ...images] = toApiMessages(message);
    out.push(first);
    if (message.role === "tool") feedback.push(...images);
    else out.push(...images);
  }
  return [...out, ...feedback];
}

export function imageToolInstructions(messages: ChatMessage[]): string {
  const catalog = messages.flatMap((m, i) => imageSources(m).map((image) => `消息 ${i + 1} · ${image.label}`));
  return `严格执行用户最新要求，保留指定文字、语言、数量、主体关系、构图与禁止项；不要擅自添加风格或元素。
需要保留、修改或组合素材时使用 edit_image，并通过 source_image_ids 明确选择全部所需图片，按用户要求的顺序排列。
素材编号按各条消息里的展示顺序，从 1 开始；图片 ID 是唯一引用。图像请求中的输入顺序与你选择的 ID 顺序一致。
编辑时明确哪些部分改变、哪些部分保持。工具成功返回实际图像后才能宣称已完成。工具失败时如实说明。
可用图片：\n${catalog.join("\n") || "暂无图片"}`;
}
