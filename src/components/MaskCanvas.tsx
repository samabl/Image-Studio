import { useCallback, useEffect, useRef, useState } from "react";
import type { Stroke } from "../lib/image";

/**
 * 蒙版画笔：在参考图上涂抹要修改的区域。
 *
 * 交互模型
 *  - 底图按容器宽度等比缩放显示（只读 canvas）；
 *  - 上面叠一层同样尺寸的绘制 canvas，用半透明红表示「将被编辑」的区域；
 *  - 笔画坐标存 0~1 归一化值，导出时再按原图分辨率重绘（见 lib/image.ts 的 renderMask）。
 *
 * 用 Pointer Events 统一鼠标 / 触屏 / 手写笔，Android 上同样可用。
 */
export function MaskCanvas({
  image,
  strokes,
  onStrokesChange,
  brushSize,
  disabled,
}: {
  image: string;
  strokes: Stroke[];
  onStrokesChange: (s: Stroke[]) => void;
  brushSize: number;
  disabled?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const current = useRef<Stroke | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [over, setOver] = useState(false);

  /** 按图片原始比例算出显示尺寸 */
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const maxW = wrapRef.current?.clientWidth ?? 360;
      const ratio = img.naturalHeight / img.naturalWidth;
      const w = Math.max(60, Math.min(maxW, 720));
      setSize({ w, h: Math.round(w * ratio) });
    };
    img.src = image;
    return () => {
      cancelled = true;
    };
  }, [image]);

  /** 重绘底图 */
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, size.w, size.h);
    };
    img.src = image;
  }, [image, size]);

  /** 重绘涂鸦层 */
  const redraw = useCallback(() => {
    const canvas = drawRef.current;
    if (!canvas || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(239, 68, 68, 0.55)";
    ctx.fillStyle = "rgba(239, 68, 68, 0.55)";

    const all = current.current ? [...strokes, current.current] : strokes;
    const minSide = Math.min(size.w, size.h);
    for (const s of all) {
      const lw = Math.max(1, s.size * minSide);
      ctx.lineWidth = lw;
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(s.points[0].x * size.w, s.points[0].y * size.h, lw / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * size.w, s.points[0].y * size.h);
      for (let i = 1; i < s.points.length; i += 1) {
        ctx.lineTo(s.points[i].x * size.w, s.points[i].y * size.h);
      }
      ctx.stroke();
    }
  }, [size, strokes]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const toNorm = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    current.current = { size: brushSize, points: [toNorm(e)] };
    redraw();
  };

  const move = (e: React.PointerEvent) => {
    if (!drawing.current || !current.current) return;
    current.current.points.push(toNorm(e));
    redraw();
  };

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (current.current) {
      onStrokesChange([...strokes, current.current]);
      current.current = null;
    }
    setOver(false);
  };

  return (
    <div
      ref={wrapRef}
      className="mask-stage"
      style={{ width: size.w || "100%", cursor: disabled ? "default" : "crosshair" }}
    >
      <canvas ref={baseRef} style={{ width: size.w, height: size.h }} />
      <canvas
        ref={drawRef}
        style={{ position: "absolute", inset: 0, width: size.w, height: size.h }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={up}
        onPointerEnter={() => setOver(true)}
        onPointerOut={() => setOver(false)}
      />
      {size.w === 0 && <div style={{ height: 180 }} />}
      {over && !disabled && (
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            pointerEvents: "none",
          }}
        >
          涂抹要修改的区域
        </div>
      )}
    </div>
  );
}
