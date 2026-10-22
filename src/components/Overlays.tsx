import { create } from "zustand";
import { useToast } from "../lib/store";
import { copyText, revealPath } from "../lib/shell";
import { SaveImageButton } from "./SaveImageButton";
import { isDesktop } from "../lib/platform";
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
  if (!image) return null;

  const item = image.item ?? null;
  const src = image.dataUrl || image.path || item?.dataUrl || item?.path || "";

  return (
    <div className="lightbox" onClick={hide}>
      <button type="button" className="btn icon lightbox-close" onClick={hide} title="关闭">
        ✕
      </button>
      <div onClick={(e) => e.stopPropagation()}>
        <FileImage dataUrl={image.dataUrl || item?.dataUrl} path={image.path ?? item?.path} alt={image.title ?? ""} />
      </div>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {image.title && <span className="chip">{image.title}</span>}
        {item && (
          <>
            <span className="chip">{item.model}</span>
            <span className="chip">{item.size}</span>
            <span className="chip">{new Date(item.createdAt).toLocaleString()}</span>
          </>
        )}
      </div>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn sm"
          onClick={() => void copyText(src).then(() => useToast.getState().push("success", "已复制"))}
        >
          {src.startsWith("data:") ? "复制 DataURL" : "复制路径"}
        </button>
        <SaveImageButton image={image} />
        {isDesktop && item && (
          <>
            <button
              type="button"
              className="btn sm"
              onClick={() => void revealPath(item.path).catch(() => undefined)}
            >
              打开所在文件夹
            </button>
          </>
        )}
      </div>
    </div>
  );
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
