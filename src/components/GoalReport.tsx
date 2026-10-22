import type { GoalProgress, GoalReview } from "../types";
import { GOAL_LEVELS } from "../lib/goal";
import { Markdown } from "./Markdown";

const LABELS = { working: "正在执行", satisfied: "已满足要求", needs_revision: "需要修正", blocked: "遇到障碍", limit: "达到上限", stopped: "已停止", error: "请求失败" };

export function GoalReport({ progress, review }: { progress?: GoalProgress; review?: GoalReview }) {
  const status = progress?.status ?? review?.status ?? "working";
  const checks = progress?.checks ?? review?.checks;
  return <div className={`goal-report ${status}`}>
    <div className="goal-report-head"><strong>Goal · {LABELS[status]}</strong>
      {progress && <span>{GOAL_LEVELS[progress.level].label} · 修正 {progress.corrections}/{progress.maxCorrections} · 图像调用 {progress.attempts} 次</span>}
    </div>
    {(progress?.summary || review?.summary) && <div className="goal-report-summary">{progress?.summary || review?.summary}</div>}
    {!!checks?.length && <ul className="goal-checks">{checks.map((check, index) => <li key={index}>
      <span className={check.passed ? "goal-check-pass" : "goal-check-fail"}>{check.passed ? "✓" : "×"}</span>
      <div><strong>{check.requirement}</strong><div>{check.details}</div></div>
    </li>)}</ul>}
    {!!review?.imageIds.length && <div className="goal-evidence">验收图片：{review.imageIds.join("、")}</div>}
    {review?.answer && <div className="goal-answer"><Markdown source={review.answer} /></div>}
  </div>;
}
