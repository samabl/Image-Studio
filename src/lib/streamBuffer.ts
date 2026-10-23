import type { ChatEvent, ToolCall } from "../types";

export const STREAM_BATCH_MS = 50;
type Increment = Extract<ChatEvent, { type: "delta" | "reasoning" | "toolCalls" }>;
interface Batch { content: string; reasoning: string; toolCalls?: ToolCall[]; }

/** WebView 绘制最多约 20 次/秒。终止、错误、停止时必须先 flush，不能丢末尾 token。 */
export function createStreamBuffer(publish: (batch: Batch) => void, interval = STREAM_BATCH_MS) {
  let content: string[] = [];
  let reasoning: string[] = [];
  let toolCalls: ToolCall[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!content.length && !reasoning.length && toolCalls === undefined) return;
    const batch: Batch = { content: content.join(""), reasoning: reasoning.join(""), toolCalls };
    content = []; reasoning = []; toolCalls = undefined;
    publish(batch);
  };
  return {
    push: (event: Increment) => {
      if (event.type === "delta") content.push(event.text);
      else if (event.type === "reasoning") reasoning.push(event.text);
      else toolCalls = event.calls;
      if (timer === undefined) timer = setTimeout(flush, interval);
    },
    flush,
  };
}
