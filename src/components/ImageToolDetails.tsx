import { copyText } from "../lib/shell";
import { useToast } from "../lib/store";
import type { ToolCall } from "../types";

/** 工具指令就是 AI 润色后的提示词，必须作为消息保留，不能只放在临时状态里。 */
export function ImageToolDetails({ call, labels, sentPrompt }: {
  call: ToolCall;
  labels?: string[];
  sentPrompt?: string;
}) {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments || "{}"); } catch { /* 显示未解析的参数，避免丢掉历史。 */ }
  const prompt = typeof args?.prompt === "string" ? args.prompt : call.arguments;
  const ids = Array.isArray(args?.source_image_ids) ? args.source_image_ids.filter((id): id is string => typeof id === "string") : [];
  const sources = labels?.length ? labels : ids;
  const name = call.name === "edit_image" ? "AI 编辑指令" : call.name === "generate_image" ? "AI 生图指令" : call.name;
  return (
    <details className="image-tool-details" open>
      <summary>🔧 {name}</summary>
      <div className="image-tool-content">
        {sources.length > 0 && <div className="image-tool-sources">输入顺序：{sources.join(" → ")}</div>}
        <div className="image-tool-prompt">{prompt || "模型未提供图像指令"}</div>
        <button type="button" className="btn sm ghost" onClick={() => void copyText(prompt)
          .then(() => useToast.getState().push("success", "已复制完整指令"))
          .catch((err: Error) => useToast.getState().push("error", err.message))}>复制完整指令</button>
        {sentPrompt && sentPrompt !== prompt && (
          <details className="image-tool-sent">
            <summary>查看实际发送内容（含原始要求）</summary>
            <div className="image-tool-prompt">{sentPrompt}</div>
          </details>
        )}
      </div>
    </details>
  );
}
