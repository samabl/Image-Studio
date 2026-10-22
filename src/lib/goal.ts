import type { GoalLevel, GoalReview, GoalSettings, ImageConfig } from "../types";

export const GOAL_LEVELS: Record<GoalLevel, { label: string; description: string; corrections: number }> = {
  relaxed: { label: "宽松", description: "满足核心内容、风格与主要用途；允许不影响目标的细节差异。明确的文字、数量、禁止项和必须保留内容仍需遵守。", corrections: 1 },
  standard: { label: "标准", description: "逐项满足用户明确要求，检查文字、数量、构图、素材对应关系、风格和主要视觉缺陷。", corrections: 3 },
  strict: { label: "严格", description: "逐项严格验收全部明确要求，并细查文字准确性、人物/物体数量、素材一致性、边缘、合成接缝及布局；发现明显偏差就继续修正。", corrections: 6 },
};

export function goalSettings(value?: Partial<GoalSettings>): GoalSettings {
  const level = value?.level && Object.prototype.hasOwnProperty.call(GOAL_LEVELS, value.level) ? value.level : "standard";
  const max = value?.maxCorrections;
  return { enabled: value?.enabled === true, level, maxCorrections: typeof max === "number" && Number.isFinite(max) ? Math.min(20, Math.max(0, Math.floor(max))) : GOAL_LEVELS[level].corrections };
}

export function goalInstructions(settings: GoalSettings, corrections: number): string {
  return `Goal 模式已开启，验收等级：${GOAL_LEVELS[settings.level].label}。${GOAL_LEVELS[settings.level].description}\n最多修正 ${settings.maxCorrections} 次，当前已修正 ${corrections} 次。先整理当前用户目标及必须遵守的要求，再完成任务。涉及图片时必须检查实际回图；编号只是图片引用，不能仅凭生图提示词判断达标。每次成图后调用 review_goal，逐项提供通过/未通过及依据，并提供本次最新最终图片的真实 image_ids。needs_revision 后自行使用图像工具修正，再检查新回图；不要等用户手动催促。满意时用 satisfied；真实能力/服务限制无法继续时用 blocked 并说明原因，不能假称成功。文字任务可不传图片，但 satisfied 必须用 answer 给出完整最终答案。文字任务需要修正时自行改写答案，再重新验收。修正不能改变原始要求、扩大任务或添加无关元素。不要编造图片 ID，也不能用仅文生图的模型编辑参考图。`;
}

export const goalReviewTool = {
  type: "function",
  function: {
    name: "review_goal",
    description: "检查实际最终成果是否满足当前用户目标。图像任务必须看实际图片并提供真实图片 ID；每次修改后重新验收。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["satisfied", "needs_revision", "blocked"] },
        summary: { type: "string", description: "当前判断及依据；不能继续时说明实际障碍。" },
        checks: { type: "array", minItems: 1, items: { type: "object", properties: { requirement: { type: "string" }, passed: { type: "boolean" }, details: { type: "string" } }, required: ["requirement", "passed", "details"] }, description: "逐项列出用户要求及验收依据，不能遗漏明确约束。" },
        image_ids: { type: "array", items: { type: "string" }, description: "被检查的实际图片 ID，必须包括本次最新最终成图。文字任务可为空。" },
        answer: { type: "string", description: "纯文字任务达标时提供完整最终答案；图像任务可省略。" },
      },
      required: ["status", "summary", "checks"],
    },
  },
};

export function parseGoalReview(args: Record<string, unknown>): GoalReview {
  if (!["satisfied", "needs_revision", "blocked"].includes(String(args.status))) throw new Error("Goal 检查状态无效");
  if (typeof args.summary !== "string" || !args.summary.trim()) throw new Error("Goal 检查必须说明判断依据");
  if (!Array.isArray(args.checks) || !args.checks.length || args.checks.length > 40) throw new Error("Goal 检查必须逐项列出要求");
  const checks = args.checks.map((item) => {
    if (!item || typeof item !== "object" || typeof item.requirement !== "string" || !item.requirement.trim() || typeof item.passed !== "boolean" || typeof item.details !== "string" || !item.details.trim()) throw new Error("Goal 检查项必须包含要求、是否通过及实际依据");
    return { requirement: item.requirement.trim(), passed: item.passed, details: item.details.trim() };
  });
  const ids = args.image_ids ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) throw new Error("Goal 图片 ID 必须是无重复的有效字符串数组");
  const status = args.status as GoalReview["status"];
  if (status === "satisfied" && checks.some((check) => !check.passed)) throw new Error("仍有未通过的要求，不能判定 Goal 已满足");
  if (status === "needs_revision" && checks.every((check) => check.passed)) throw new Error("需要修正时必须指出至少一项未通过的要求");
  const answer = typeof args.answer === "string" ? args.answer.trim() : undefined;
  if (status === "satisfied" && !ids.length && !answer) throw new Error("文字 Goal 达标时必须提供完整 answer；图像 Goal 必须提供实际图片 ID");
  return { status, summary: args.summary.trim(), checks, imageIds: ids, answer };
}

/** 服务错误回给 Chat 时隐藏本机连接密钥和地址。 */
export function imageFailureMessage(error: unknown, config: ImageConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = [config.apiKey, config.baseUrl, ...(config.modelPool ?? []).flatMap((model) => [model.apiKey ?? "", model.baseUrl ?? ""])].map((value) => value.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of values) message = message.replaceAll(value, "[已隐藏连接信息]");
  return message.slice(0, 4000);
}
