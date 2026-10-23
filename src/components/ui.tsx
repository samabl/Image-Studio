import React, { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readImageDataUrl } from "../lib/api";
import { commitNumberDraft } from "../lib/numberInput";

export function Panel({ title, children, defaultOpen = false, className = "" }: {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className={`panel ${className}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="panel-heading">{title}</summary>
    <div className="panel-body">{children}</div>
  </details>;
}

export function NumberInput({ value, onValueChange, min = 0, max = Number.MAX_SAFE_INTEGER, onBlur, onKeyDown, ...props }: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type">) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input {...props} type="number" inputMode="numeric" step={1} min={min} max={max} value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={(event) => {
      const next = commitNumberDraft(event.currentTarget.value, value, min, max);
      setDraft(String(next));
      onValueChange(next);
      onBlur?.(event);
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      onKeyDown?.(event);
    }} />;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} />;
}

export function Field({
  label,
  hint,
  children,
  right,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>
        {label}
        {right && <span style={{ marginLeft: "auto" }}>{right}</span>}
      </label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`switch${disabled ? " disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? "active" : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({
  icon,
  title,
  hint,
  children,
}: {
  icon: string;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontSize: 15, color: "var(--text-dim)" }}>{title}</div>
      {hint && <div style={{ fontSize: 12.5, maxWidth: 420 }}>{hint}</div>}
      {children}
    </div>
  );
}

/**
 * 同时支持两种来源的图片：
 *  - dataUrl：本次会话新生成/新导入的图，直接显示；
 *  - path：图库历史文件，走 Tauri asset 协议。
 *
 * asset 协议在个别环境/权限下可能拿不到，一旦 onError 就回退调用
 * `read_image_data_url` 把文件读成 data URL，保证图一定显示得出来。
 */
export function FileImage({
  dataUrl,
  path,
  alt,
  onClick,
  className,
  style,
  onLoad,
}: {
  dataUrl?: string | null;
  path?: string | null;
  alt?: string;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
}) {
  const initial = dataUrl ?? (path ? convertFileSrc(path) : null);
  const [src, setSrc] = useState<string | null>(initial);
  const [triedFallback, setTriedFallback] = useState(false);

  useEffect(() => {
    setSrc(dataUrl ?? (path ? convertFileSrc(path) : null));
    setTriedFallback(false);
  }, [dataUrl, path]);

  if (!src) return null;

  return (
    <img
      src={src}
      alt={alt ?? ""}
      className={className}
      style={style}
      loading="lazy"
      draggable={false}
      onClick={onClick}
      onLoad={onLoad}
      onError={() => {
        if (triedFallback || !path) return;
        setTriedFallback(true);
        void readImageDataUrl(path)
          .then(setSrc)
          .catch(() => setSrc(null));
      }}
    />
  );
}
