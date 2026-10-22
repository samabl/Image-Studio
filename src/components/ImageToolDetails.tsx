import { copyText } from "../lib/shell";
import { useToast } from "../lib/store";
import type { ToolCall } from "../types";
import { IMAGE_API_LABELS } from "../lib/imageModels";

/** 工具指令就是 AI 润色后的提示词，必须作为消息保留，不能只放在临时状态里。 */
export function ImageToolDetails({ call, labels, sentPrompt }: {
  call: ToolCall;
  labels?: string[];
  sentPrompt?: string;
}) {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments || "{}"); } catch { /* 显示未解析的参数，避免丢掉历史。 */ }
  const prompt = typeof args?.prompt === "string" ? args.prompt : call.name === "retry_image" ? sentPrompt || call.sentPrompt || call.arguments : call.arguments;
  const size = call.requestedSize ?? args?.size;
  const ids = Array.isArray(args?.source_image_ids) ? args.source_image_ids.filter((id): id is string => typeof id === "string") : [];
  const sources = labels?.length ? labels : ids;
  const name = call.name === "edit_image" ? "AI 编辑指令" : call.name === "generate_image" ? "AI 生图指令" : call.name === "retry_image" ? "AI 重试 / 切换模型" : call.name;
  return (
    <details className="image-tool-details" open>
      <summary>🔧 {name}</summary>
      <div className="image-tool-content">
        {(call.imageModel || typeof args?.model === "string") && <div className="image-tool-sources">生图模型：{call.imageModel || String(args.model)}{call.imageApiMode ? ` · ${IMAGE_API_LABELS[call.imageApiMode]}` : ""}{(call.imageStage || args.stage) ? ` · ${(call.imageStage || args.stage) === "asset" ? "中间素材" : "最终成图"}` : ""}</div>}
        {sources.length > 0 && <div className="image-tool-sources">输入顺序：{sources.join(" → ")}</div>}
        {call.retryOf && <div className="image-tool-sources">重试失败调用：{call.retryOf}</div>}
        {typeof size === "string" && <div className="image-tool-sources">请求尺寸：{size === "auto" ? "模型自动决定" : size}</div>}
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
