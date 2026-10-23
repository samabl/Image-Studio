/** 编辑中的空值不等于 0；只在提交编辑时恢复旧值或限制范围。 */
export function commitNumberDraft(text: string, previous: number, min: number, max: number): number {
  if (!text.trim()) return previous;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : previous;
}
