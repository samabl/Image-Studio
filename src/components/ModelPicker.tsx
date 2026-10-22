import { useState } from "react";

export function ModelPicker({ value, models, onChange, onBlur }: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  onBlur: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = models.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="model-picker">
      <input className="input" value={value} placeholder="输入任意模型 ID，或从列表选择"
        aria-label="模型 ID" onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
      <details onToggle={(e) => { if (!e.currentTarget.open) setQuery(""); }}>
        <summary>选择模型（{models.length} 个）</summary>
        <input className="input" value={query} placeholder="搜索全部模型…" aria-label="搜索全部模型"
          onChange={(e) => setQuery(e.target.value)} />
        <div className="model-options">
          {shown.map((model) => (
            <button type="button" className={`btn sm ${model === value ? "primary" : "ghost"}`}
              key={model} onClick={() => { onChange(model); onBlur(); }}>{model}</button>
          ))}
          {!shown.length && <span className="hint">{models.length ? "没有匹配的模型，可直接输入 ID。" : "先拉取模型列表，也可直接输入 ID。"}</span>}
        </div>
      </details>
    </div>
  );
}
