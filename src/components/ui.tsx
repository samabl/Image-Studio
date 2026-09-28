import React, { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readImageDataUrl } from "../lib/api";

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
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
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
}: {
  dataUrl?: string | null;
  path?: string | null;
  alt?: string;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
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
