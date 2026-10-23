import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { FileImage } from "./ui";
import { AddToGalleryButton } from "./AddToGalleryButton";
import { SaveImageButton } from "./SaveImageButton";
import { toast } from "../lib/store";
import { copyText, revealPath } from "../lib/shell";
import { isDesktop } from "../lib/platform";
import { clampPreview, FIT_PREVIEW, fitPreview, MAX_PREVIEW_SCALE, MIN_PREVIEW_SCALE, zoomPreview, type PreviewPoint, type PreviewView } from "../lib/preview";
import type { LightboxImage } from "./Overlays";

interface Gesture { view: PreviewView; center: PreviewPoint; distance: number }
const centerOf = (points: PreviewPoint[]) => points.length > 1
  ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0];
const distanceOf = (points: PreviewPoint[]) => points.length > 1
  ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;

export function ImagePreview({ image, hide }: { image: LightboxImage; hide: () => void }) {
  const item = image.item ?? null;
  const dataUrl = image.dataUrl || item?.dataUrl;
  const path = image.path || item?.path;
  const src = dataUrl || path || "";
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<PreviewView>(FIT_PREVIEW);
  const viewRef = useRef(view);
  const pointers = useRef(new Map<number, PreviewPoint>());
  const gesture = useRef<Gesture | null>(null);
  const bounds = useMemo(() => fitPreview(stage.width, stage.height, natural.width, natural.height), [stage, natural]);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const update = (next: PreviewView) => { viewRef.current = next; setView(next); };
  const zoom = (factor: number) => update(zoomPreview(viewRef.current, viewRef.current.scale * factor, { x: 0, y: 0 }, boundsRef.current));
  const point = (clientX: number, clientY: number): PreviewPoint => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    update(FIT_PREVIEW);
    // 缓存图片可能在 effect 前已触发 load，不能把已读到的尺寸清零。
    const loaded = stageRef.current?.querySelector("img");
    setNatural({ width: loaded?.complete ? loaded.naturalWidth : 0, height: loaded?.complete ? loaded.naturalHeight : 0 });
    pointers.current.clear();
    gesture.current = null;
  }, [src]);

  useEffect(() => {
    const element = stageRef.current!;
    const measure = () => { const rect = element.getBoundingClientRect(); setStage({ width: rect.width, height: rect.height }); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => { update(clampPreview(viewRef.current, bounds)); }, [bounds]);
  useEffect(() => {
    const element = stageRef.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? boundsRef.current.height : 1);
      update(zoomPreview(viewRef.current, viewRef.current.scale * Math.exp(-delta * 0.002), point(event.clientX, event.clientY), boundsRef.current));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const beginGesture = () => {
    const points = [...pointers.current.values()];
    gesture.current = points.length ? { view: { ...viewRef.current }, center: centerOf(points), distance: distanceOf(points) } : null;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointers.current.set(event.pointerId, point(event.clientX, event.clientY));
    event.currentTarget.setPointerCapture(event.pointerId);
    beginGesture();
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, point(event.clientX, event.clientY));
    const points = [...pointers.current.values()];
    const origin = gesture.current;
    const center = centerOf(points);
    if (points.length > 1 && origin.distance > 0) {
      update(zoomPreview(origin.view, origin.view.scale * distanceOf(points) / origin.distance, origin.center, boundsRef.current, center));
    } else {
      update(clampPreview({ ...origin.view, x: origin.view.x + center.x - origin.center.x, y: origin.view.y + center.y - origin.center.y }, boundsRef.current));
    }
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    beginGesture();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); hide(); }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.25); }
    else if (event.key === "-") { event.preventDefault(); zoom(0.8); }
    else if (event.key === "0" || event.key === "Home") { event.preventDefault(); update(FIT_PREVIEW); }
    else if (event.key === "Tab") {
      const focusable = [...dialogRef.current!.querySelectorAll<HTMLElement>("button:not(:disabled), summary, [tabindex='0']")].filter((element) => element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };

  return <div className="lightbox" onClick={(event) => { if (event.target === event.currentTarget) hide(); }}>
    <div ref={dialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-label="图片预览" onKeyDown={keyDown}>
      <div className="preview-toolbar">
        <span className="preview-title" title={image.title}>{image.title || "图片预览"}</span>
        <div className="preview-zoom-controls">
          <button type="button" className="btn icon" aria-label="缩小图片" disabled={view.scale <= MIN_PREVIEW_SCALE} onClick={() => zoom(0.8)}>−</button>
          <output aria-label="缩放比例">{Math.round(view.scale * 100)}%</output>
          <button type="button" className="btn icon" aria-label="放大图片" disabled={view.scale >= MAX_PREVIEW_SCALE} onClick={() => zoom(1.25)}>＋</button>
          <button type="button" className="btn sm ghost" onClick={() => update(FIT_PREVIEW)}>适应</button>
        </div>
        <button ref={closeRef} type="button" className="btn icon" onClick={hide} aria-label="关闭预览">✕</button>
      </div>
      <div ref={stageRef} className={`preview-stage${view.scale > 1 ? " zoomed" : ""}`} data-scale={view.scale}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
        onDoubleClick={(event) => update(zoomPreview(viewRef.current, viewRef.current.scale > 1 ? 1 : 2.5, point(event.clientX, event.clientY), boundsRef.current))}>
        <FileImage key={src} dataUrl={dataUrl} path={path} alt={image.title || item?.prompt || "预览图片"}
          style={{ width: bounds.imageWidth || undefined, height: bounds.imageHeight || undefined, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      </div>
      <div className="preview-footer">
        <div className="preview-actions">{item && <AddToGalleryButton item={item} />}<SaveImageButton image={{ ...image, dataUrl, path }} /></div>
        <details className="preview-info"><summary>图片信息</summary>
          {item && <><div className="preview-meta"><span className="chip">{item.model}</span><span className="chip">{item.size}</span><span className="chip">{new Date(item.createdAt).toLocaleString()}</span></div><p>{item.prompt}</p></>}
          <div className="preview-actions">
            <button type="button" className="btn sm ghost" onClick={() => void copyText(src).then(() => toast.success("已复制")).catch((error: Error) => toast.error(error.message))}>{dataUrl ? "复制 DataURL" : "复制路径"}</button>
            {isDesktop && path && <button type="button" className="btn sm ghost" onClick={() => void revealPath(path).catch((error: Error) => toast.error(error.message))}>打开所在文件夹</button>}
          </div>
        </details>
      </div>
    </div>
  </div>;
}
