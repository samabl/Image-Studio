import { useGallery, toast } from "../lib/store";
import type { GalleryItem } from "../types";

export function AddToGalleryButton({ item }: { item: GalleryItem }) {
  const saved = useGallery((state) => state.items.some((image) => image.id === item.id));
  const pending = useGallery((state) => state.archiving.includes(item.id));
  return <button type="button" className={`btn sm ${saved ? "ghost" : ""}`} disabled={saved || pending}
    onClick={() => void useGallery.getState().archive(item)
      .then(() => toast.success("已加入图库"))
      .catch((error: Error) => toast.error(`入库失败：${error.message}`))}>
    {saved ? "✓ 已入库" : pending ? "入库中…" : "＋ 加入图库"}
  </button>;
}
