/** 工具显式指定 auto 时交给图像服务决定；未指定沿用用户设置。 */
export function imageToolSize(value: unknown, fallback: string): string | undefined {
  if (value === undefined) value = fallback;
  if (typeof value !== "string") throw new Error("图像尺寸必须是 auto 或宽x高字符串");
  const size = value.trim().toLowerCase().replace(/×/g, "x");
  if (!size || size === "auto") return undefined;
  if (!/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(size)) throw new Error("图像尺寸格式应为宽x高，例如 1536x1024");
  return size;
}


/** 显式画质仅适用于 Images；Gemini/Chat 使用分辨率档位，不能悄悄忽略参数。 */
export function imageToolQuality(value: unknown, fallback: string, mode: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("quality 必须是画质字符串");
  const quality = value.trim().toLowerCase();
  if (!["auto", "low", "medium", "high", "standard", "hd"].includes(quality)) throw new Error("quality 仅支持 auto / low / medium / high / standard / hd");
  if (mode !== "images" && quality !== "auto") throw new Error("Gemini/Chat 出图不使用 quality，请用 image_size 指定 1K / 2K / 4K 分辨率档位");
  return quality;
}

export function imageToolResolution(value: unknown, mode: string): "1K" | "2K" | "4K" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("image_size 必须是 auto / 1K / 2K / 4K");
  const resolution = value.trim().toUpperCase();
  if (resolution === "AUTO") return undefined;
  if (resolution !== "1K" && resolution !== "2K" && resolution !== "4K") throw new Error("image_size 仅支持 auto / 1K / 2K / 4K");
  if (mode === "images") throw new Error("Images 接口不使用 image_size，请用 size 指定具体尺寸，并用 quality 指定画质");
  return resolution;
}
