/** 工具显式指定 auto 时交给图像服务决定；未指定沿用用户设置。 */
export function imageToolSize(value: unknown, fallback: string): string | undefined {
  if (value === undefined) value = fallback;
  if (typeof value !== "string") throw new Error("图像尺寸必须是 auto 或宽x高字符串");
  const size = value.trim().toLowerCase().replace(/×/g, "x");
  if (!size || size === "auto") return undefined;
  if (!/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(size)) throw new Error("图像尺寸格式应为宽x高，例如 1536x1024");
  return size;
}
