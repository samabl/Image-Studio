import type { GoalCheck, GoalProgress, GoalReview } from "../types";
import { Markdown } from "./Markdown";

const LABELS = { working: "正在执行", satisfied: "已达标", needs_revision: "需要修正", blocked: "遇到障碍", limit: "达到上限", stopped: "已停止", error: "请求失败" };

export function GoalChecks({ checks }: { checks?: GoalCheck[] }) {
  if (!checks?.length) return null;
  return <ul className="goal-checks">{checks.map((check, index) => <li key={index}>
    <span className={check.passed ? "goal-check-pass" : "goal-check-fail"}>{check.passed ? "✓" : "×"}</span>
    <div><strong>{check.requirement}</strong>{check.score !== undefined && <span className="chip">{check.score}/100</span>}<div>{check.details}</div></div>
  </li>)}</ul>;
}

export function GoalReport({ progress, review }: { progress?: GoalProgress; review?: GoalReview }) {
  const status = progress?.status ?? review?.status ?? "working";
  const checks = progress?.checks ?? review?.checks;
  const score = progress?.score ?? review?.score;
  const target = progress?.targetScore ?? review?.targetScore;
  const scorer = progress?.scorer ?? review?.scorer;
  const reviewers = progress?.reviewerScores ?? review?.reviewerScores;
  return <div className={`goal-report ${status}`}>
    <div className="goal-report-head"><strong>Goal · {LABELS[status]}</strong>
      {progress && <span>修正 {progress.corrections}/{progress.maxCorrections} · 图像调用 {progress.attempts} 次</span>}
    </div>
    <div className="goal-score-line">
      {score !== undefined ? <strong className="goal-score">{score}<small>/100</small></strong> : <span>{target !== undefined ? "等待独立评分" : "历史验收记录（无分数）"}</span>}
      {target !== undefined && <span className="chip">目标 ≥ {target} 分</span>}
      {scorer && <span className="chip">{scorer === "jury" ? "评审团平均分" : "Chat 模型评分"}</span>}
    </div>
    {!!reviewers?.length && <div className="goal-reviewer-scores">{reviewers.map((member, index) => <span className="chip" key={`${member.memberId}_${index}`} title={`${member.model}：${member.summary}`}>{member.name} · {member.score} 分</span>)}</div>}
    {(progress?.summary || review?.summary) && <div className="goal-report-summary">{progress?.summary || review?.summary}</div>}
    <GoalChecks checks={checks} />
    {!!review?.imageIds.length && <div className="goal-evidence">验收图片：{review.imageIds.join("、")}</div>}
    {review?.answer && <div className="goal-answer"><Markdown source={review.answer} /></div>}
  </div>;
}
