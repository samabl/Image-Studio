import { Panel, Spinner } from "./ui";
import { copyText } from "../lib/shell";
import { useToast } from "../lib/store";
import type { CodeExecution } from "../types";

const STATUS = { running: "执行中", complete: "已完成", error: "失败", stopped: "已停止" };
export function CodeExecutionReport({ execution }: { execution: CodeExecution }) {
  return <Panel className="code-report" title={<>{execution.status === "running" && <Spinner />} 内置 JS · {STATUS[execution.status]}{execution.elapsedMs !== undefined ? ` · ${execution.elapsedMs} ms` : ""}</>}>
    <div>{execution.description}</div>
    <div className="hint">输入：{execution.sourceLabels.join(" → ")}</div>
    {execution.outputSizes?.length ? <div className="hint">输出：{execution.outputSizes.join("、")}</div> : null}
    <pre className="code-source"><code>{execution.code}</code></pre>
    <button type="button" className="btn sm ghost" onClick={() => void copyText(execution.code)
      .then(() => useToast.getState().push("success", "已复制代码"))
      .catch((error: Error) => useToast.getState().push("error", error.message))}>复制代码</button>
    {execution.logs.length > 0 && <details><summary>运行日志</summary><pre className="code-source">{execution.logs.join("\n")}</pre></details>}
    {execution.error && <div className="err">{execution.error}</div>}
  </Panel>;
}
