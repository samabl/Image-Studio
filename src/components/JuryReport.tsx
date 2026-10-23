import { Panel, Spinner } from "./ui";
import { Markdown } from "./Markdown";
import { GoalChecks } from "./GoalReport";
import type { JuryReview } from "../types";

const STATUS = { reviewing: "评审中", complete: "评审完成", partial: "部分完成", failed: "评审未完成", stopped: "已停止" };
const OPINION_STATUS = { pending: "评审中", complete: "已完成", error: "失败", stopped: "已停止" };

export function JuryReport({ review }: { review: JuryReview }) {
  const completed = review.opinions.filter((opinion) => opinion.status === "complete").length;
  return <Panel className="jury-report" title={<>{review.status === "reviewing" && <Spinner />} 评审团 · {completed}/{review.opinions.length} · {STATUS[review.status]}</>}>
    <div className="hint">{review.imageIds.length ? `图片：${review.imageIds.join("、")}` : "文字成果评分"}</div>
    {!review.opinions.length && <div className="err">没有启用的评审模型。</div>}
    {review.opinions.map((opinion, index) => <section className="jury-opinion" key={`${opinion.memberId}_${index}`}>
      <div className="jury-opinion-head"><strong>{opinion.name}</strong><span className="chip">{opinion.model}</span><span className={`chip${opinion.status === "error" ? " error" : ""}`}>{OPINION_STATUS[opinion.status]}</span></div>
      {opinion.goalScore ? <>
        <div className="goal-score-line"><strong className="goal-score">{opinion.goalScore.score}<small>/100</small></strong><span>{opinion.goalScore.summary}</span></div>
        <GoalChecks checks={opinion.goalScore.checks} />
      </> : opinion.text && <Markdown source={opinion.text} />}
      {opinion.error && <div className="err">{opinion.error}</div>}
    </section>)}
  </Panel>;
}
