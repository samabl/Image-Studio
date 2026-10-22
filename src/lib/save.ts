import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { readImageDataUrl } from "./api";
import { dataUrlToBlob } from "./image";
import type { GalleryItem } from "../types";

export interface SaveableImage {
  dataUrl?: string | null;
  path?: string | null;
  item?: GalleryItem | null;
}

export async function saveImage(image: SaveableImage): Promise<string | null> {
  const path = image.path ?? image.item?.path;
  const dataUrl = image.dataUrl || image.item?.dataUrl || (path ? await readImageDataUrl(path) : null);
  if (!dataUrl) throw new Error("没有可保存的图片");
  const blob = dataUrlToBlob(dataUrl);
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[blob.type];
  if (!extension) throw new Error(`暂不支持保存 ${blob.type} 格式`);
  const originalName = image.item?.fileName || path?.split(/[\\/]/).pop() || `image-${Date.now()}.${extension}`;
  const fileName = originalName.replace(/\.[^.]+$/, `.${extension}`);
  const target = await save({ title: "保存图像", defaultPath: fileName, filters: [{ name: `图像 (${extension.toUpperCase()})`, extensions: [extension] }] });
  if (!target) return null;
  await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
  return target;
}
