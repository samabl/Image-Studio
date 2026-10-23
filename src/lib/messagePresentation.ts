import type { ChatMessage, ToolCall } from "../types";

/** 工具调用仍保留在会话/API 历史中；这里只决定是否绘制消息气泡。 */
export function displayToolCalls(calls?: ToolCall[]): ToolCall[] {
  return (calls ?? []).filter((call) => !["review_goal", "review_images", "edit_image_code"].includes(call.name));
}

export function hasDisplayText(text?: string): boolean {
  return Boolean(text?.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim());
}

export function hasVisibleMessage(message: ChatMessage, live = false): boolean {
  if (hasDisplayText(message.content) || hasDisplayText(message.reasoning) || hasDisplayText(message.error)
    || message.attachments?.length || message.images?.length || message.goalReview || message.goalProgress
    || message.juryReview || message.codeExecution || message.pending) return true;
  if (displayToolCalls(message.toolCalls).length) return true;
  // 首个 token 到来前显示非空的思考提示；隐藏仅含内部评审/代码调用的助手回合。
  return live && !message.toolCalls?.length;
}
