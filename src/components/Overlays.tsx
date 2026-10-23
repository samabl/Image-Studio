import { create } from "zustand";
import { useToast } from "../lib/store";
import { ImagePreview } from "./ImagePreview";
import { FileImage } from "./ui";
import type { GalleryItem } from "../types";

// ---------------------------------------------------------------------------
// Toast 容器
// ---------------------------------------------------------------------------

export function Toasts() {
  const toasts = useToast((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 灯箱：全局单例，任何组件调 showImage() 即可
// ---------------------------------------------------------------------------

export interface LightboxImage {
  dataUrl?: string | null;
  path?: string | null;
  item?: GalleryItem | null;
  title?: string;
}

interface LightboxState {
  image: LightboxImage | null;
  show: (image: LightboxImage) => void;
  hide: () => void;
}

export const useLightbox = create<LightboxState>((set) => ({
  image: null,
  show: (image) => set({ image }),
  hide: () => set({ image: null }),
}));

export const showImage = (image: LightboxImage) => useLightbox.getState().show(image);

export function Lightbox() {
  const { image, hide } = useLightbox();
  return image ? <ImagePreview image={image} hide={hide} /> : null;
}

/** 图库里直接用的缩略图 + 点击放大。 */
export function GalleryThumb({ item }: { item: GalleryItem }) {
  return (
    <FileImage
      dataUrl={item.dataUrl}
      path={item.path}
      alt={item.prompt}
      onClick={() => showImage({ item, path: item.path, dataUrl: item.dataUrl })}
    />
  );
}
