import type { GalleryItem, GeneratedRef } from "../types";

/** 兼容旧对话的图片引用，同时保留新结果的归档元数据。 */
export function generatedGalleryItem(image: GeneratedRef): GalleryItem {
  return {
    id: image.galleryId,
    fileName: image.path.split(/[\\/]/).pop() ?? `${image.galleryId}.png`,
    path: image.path,
    dataUrl: image.dataUrl,
    kind: image.kind ?? "chat",
    prompt: image.prompt,
    model: image.model ?? "",
    size: image.size ?? "auto",
    createdAt: image.createdAt ?? Date.now(),
    parentId: image.parentId,
    revisedPrompt: image.revisedPrompt,
  };
}
