import type { GoalReview, GoalScore, GoalSettings, ImageConfig, JuryReview } from "../types";

export const GOAL_SCORERS = { auto: "自动（优先评审团）", jury: "评审团", chat: "Chat 模型" } as const;
export const DEFAULT_GOAL_SCORE = 85;
const LEGACY_LEVELS = { relaxed: { score: 70, corrections: 1 }, standard: { score: 85, corrections: 3 }, strict: { score: 95, corrections: 6 } } as const;

/** 旧会话的等级只用于迁移，不再作为新任务的验收标准。 */
export function goalSettings(value?: Partial<GoalSettings> & { level?: unknown }): GoalSettings {
  const legacy = typeof value?.level === "string" && Object.prototype.hasOwnProperty.call(LEGACY_LEVELS, value.level)
    ? LEGACY_LEVELS[value.level as keyof typeof LEGACY_LEVELS] : LEGACY_LEVELS.standard;
  const target = value?.targetScore;
  const max = value?.maxCorrections;
  const scorer = value?.scorer && Object.prototype.hasOwnProperty.call(GOAL_SCORERS, value.scorer) ? value.scorer : "auto";
  return {
    enabled: value?.enabled === true, scorer,
    targetScore: typeof target === "number" && Number.isFinite(target) ? Math.min(100, Math.max(1, Math.round(target))) : legacy.score,
    maxCorrections: typeof max === "number" && Number.isFinite(max) ? Math.min(20, Math.max(0, Math.floor(max))) : legacy.corrections,
  };
}

export function goalInstructions(settings: GoalSettings, corrections: number): string {
  return `Goal 模式已开启，采用 100 分制，目标分数：${settings.targetScore}/100，评分来源：${GOAL_SCORERS[settings.scorer]}。达到目标分数且没有违反明确要求才算达标。最多修正 ${settings.maxCorrections} 次，当前已修正 ${corrections} 次。
先整理当前用户目标及必须遵守的要求，再完成任务。涉及图片时必须检查实际回图；编号只是图片引用，不能仅凭生图提示词判断达标。每次成图后调用 review_goal，提交本次最新全部最终图片的真实 image_ids，由客户端交给评审团或 Chat 模型独立打分；你不能自行填写分数、宣称通过或篡改评审分数。
收到 needs_revision 后根据评分和逐项依据自行修正，再提交新成果评分，不要等用户催促。文字任务提交完整 answer 和空 image_ids；未达分时自行改写答案，再重新评分。真实能力或服务限制无法继续时用 blocked_reason 说明实际障碍，不能假称成功。修正不能改变原始要求、扩大任务或添加无关元素。不要编造图片 ID，也不能用仅文生图的模型编辑参考图。`;
}

export const goalReviewTool = {
  type: "function",
  function: {
    name: "review_goal",
    description: "将实际最终成果交给评审团或 Chat 独立打分。客户端依据目标分数决定通过或继续修正，不接受你自行给出的分数或通过结论。每次修改后重新提交。",
    parameters: {
      type: "object",
      properties: {
        image_ids: { type: "array", maxItems: 4, items: { type: "string" }, description: "本次最新全部最终图片的真实 ID，不重复。文字任务或报告障碍时传空数组。" },
        answer: { type: "string", description: "待评分的完整最终文字答案；不能用一句完成声明代替图片。" },
        blocked_reason: { type: "string", description: "仅当确实无法继续时说明真实能力或服务障碍；此路径不会判定通过。" },
      },
      required: ["image_ids"],
    },
  },
};

export function parseGoalSubmission(args: Record<string, unknown>) {
  const ids = args.image_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("Goal 图片 ID 必须是最多 4 个、无重复的有效字符串数组");
  }
  const answer = typeof args.answer === "string" ? args.answer.trim() : undefined;
  const blockedReason = typeof args.blocked_reason === "string" ? args.blocked_reason.trim() : undefined;
  if (!ids.length && !answer && !blockedReason) throw new Error("Goal 评分必须提供实际图片 ID 或完整 answer；无法继续时说明 blocked_reason");
  return { imageIds: ids as string[], answer, blockedReason };
}

/** 只接受评分模型返回的结构化结果，拒绝空意见、越界分数和编造的通过状态。 */
export function parseGoalScore(text: string): GoalScore {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  let result: Record<string, unknown>;
  try { result = JSON.parse(fenced ? fenced[1] : trimmed); } catch { throw new Error("评分模型未返回有效 JSON，请重新评分"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("评分结果必须是 JSON 对象");
  const validScore = (score: unknown): score is number => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
  if (!validScore(result.score)) throw new Error("评分必须是 0–100 之间的有限数值");
  if (typeof result.summary !== "string" || !result.summary.trim()) throw new Error("评分必须说明实际依据");
  if (!Array.isArray(result.checks) || !result.checks.length || result.checks.length > 40) throw new Error("评分必须逐项核对用户要求");
  const checks = result.checks.map((item) => {
    if (!item || typeof item !== "object" || typeof item.requirement !== "string" || !item.requirement.trim()
      || !validScore(item.score) || typeof item.passed !== "boolean" || typeof item.details !== "string" || !item.details.trim()) {
      throw new Error("评分项必须包含要求、0–100 分数、是否符合明确约束及实际依据");
    }
    return { requirement: item.requirement.trim(), score: item.score, passed: item.passed, details: item.details.trim() };
  });
  return { score: result.score, summary: result.summary.trim(), checks };
}

export function goalReviewFromScores(report: JuryReview, settings: GoalSettings, scorer: "chat" | "jury", answer?: string): GoalReview {
  if (report.status !== "complete" || !report.opinions.length || report.opinions.some((opinion) => opinion.status !== "complete" || !opinion.goalScore)) {
    throw new Error("评分尚未全部完成，不能判定 Goal 通过；请重试评分或说明实际障碍");
  }
  const reviewerScores = report.opinions.map((opinion) => ({ memberId: opinion.memberId, name: opinion.name, model: opinion.model,
    score: opinion.goalScore!.score, summary: opinion.goalScore!.summary }));
  const average = reviewerScores.reduce((sum, reviewer) => sum + reviewer.score, 0) / reviewerScores.length;
  const score = Math.round(average * 100) / 100;
  const checks = report.opinions.flatMap((opinion) => opinion.goalScore!.checks.map((check) => ({ ...check,
    requirement: report.opinions.length > 1 ? `${opinion.name} · ${check.requirement}` : check.requirement,
  })));
  const satisfied = average >= settings.targetScore && checks.every((check) => check.passed);
  const summary = `${scorer === "jury" ? "评审团平均" : "Chat"}评分 ${score}/100，目标 ${settings.targetScore}/100。${satisfied ? "已达标。" : average < settings.targetScore ? "未达到目标分数，需继续修正。" : "仍有明确要求未满足，需继续修正。"} ${reviewerScores.map((reviewer) => reviewer.summary).join("；")}`;
  return { status: satisfied ? "satisfied" : "needs_revision", score, targetScore: settings.targetScore, scorer,
    summary, checks, imageIds: report.imageIds, answer, reviewerScores };
}

/** 服务错误回给 Chat 时隐藏本机连接密钥和地址。 */
export function imageFailureMessage(error: unknown, config: ImageConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = [config.apiKey, config.baseUrl, ...(config.modelPool ?? []).flatMap((model) => [model.apiKey ?? "", model.baseUrl ?? ""])].map((value) => value.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of values) message = message.replaceAll(value, "[已隐藏连接信息]");
  return message.slice(0, 4000);
}
