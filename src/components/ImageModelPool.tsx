import { useEffect, useState } from "react";
import { Field } from "./ui";
import { canEditImageModel, configuredImageModels, IMAGE_API_LABELS, imageModelConnection } from "../lib/imageModels";
import type { ImageApiMode, ImageConfig, ImageModelConfig } from "../types";

export function ImageModelPool({ config, availableModels = config.models, onChange, onBlur, onFetch, loading }: {
  config: ImageConfig;
  availableModels?: string[];
  onChange: (pool: ImageModelConfig[]) => void;
  onBlur: () => void;
  onFetch?: () => void;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [customId, setCustomId] = useState("");
  const [expanded, setExpanded] = useState(true);
  const pool = configuredImageModels(config);
  const allModels = [...new Set([...availableModels, ...pool.map((entry) => entry.id)])];
  const models = allModels
    .filter((id) => id.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { setExpanded(true); setQuery(""); }, [availableModels.length]);
  useEffect(() => {
    const back = (event: Event) => { if (expanded) { event.preventDefault(); setExpanded(false); setQuery(""); } };
    window.addEventListener("image-studio-back", back);
    return () => window.removeEventListener("image-studio-back", back);
  }, [expanded]);
  const patch = (id: string, value: Partial<ImageModelConfig>) => onChange(pool.map((entry) => entry.id === id ? { ...entry, ...value } : entry));
  const add = () => {
    const id = customId.trim();
    if (!id) return;
    if (!pool.some((entry) => entry.id === id)) onChange([...pool, { id, apiMode: "auto" }]);
    setCustomId("");
    onBlur();
  };
  return (
    <div className="image-model-pool">
      <div className="hint">勾选 Chat 可调用的模型。自动模式允许不同模型分别生成素材，再使用支持参考图的模型合成；也可在会话里固定一个模型。</div>
      <div className="image-model-select">
        <div className="image-model-select-head">
          <button type="button" className="btn sm" aria-expanded={expanded} aria-controls="image-model-checkboxes" onClick={() => { setExpanded(!expanded); setQuery(""); }}>
            {expanded ? "收起模型列表" : "展开模型列表"}（{allModels.length} 个可选，已启用 {pool.length} 个）
          </button>
          {onFetch && <button type="button" className="btn sm ghost" disabled={loading} onClick={() => { setExpanded(true); setQuery(""); onFetch(); }}>{loading ? "获取中…" : "↻ 拉取可选模型"}</button>}
        </div>
        {expanded && <div id="image-model-checkboxes">
        {availableModels.length === 0 && <div className="hint">尚未拉取模型列表。点击“拉取可选模型”后即可勾选，也可手动添加。</div>}
        <input className="input" value={query} placeholder="搜索全部模型…" aria-label="搜索生图模型池" onChange={(e) => setQuery(e.target.value)} />
        <div className="image-model-options">
          {models.map((id) => {
            const selected = pool.some((entry) => entry.id === id);
            return <label className={selected ? "selected" : ""} key={id}><input type="checkbox" checked={selected} disabled={selected && pool.length === 1}
              onChange={(e) => {
                onChange(e.target.checked ? [...pool, { id, apiMode: "auto" }] : pool.filter((entry) => entry.id !== id));
                onBlur();
              }} /><span>{id}</span></label>;
          })}
          {!models.length && <div className="hint">没有匹配的模型，可在下方手动添加 ID。</div>}
        </div>
        <button type="button" className="btn sm" onClick={() => {
          setExpanded(false); setQuery(""); onBlur();
        }}>完成选择</button>
        </div>}
      </div>
      <div className="image-model-add">
        <input className="input" value={customId} placeholder="手动添加模型 ID" aria-label="添加生图模型 ID"
          onChange={(e) => setCustomId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" className="btn sm" disabled={!customId.trim()} onClick={add}>添加</button>
      </div>
      {pool.map((entry) => {
        const connection = imageModelConnection(config, entry);
        return <details className="image-model-entry" key={entry.id}>
          <summary><span>{entry.id}</span><span className="tag">{entry.apiMode === "auto" ? "自动 → " : ""}{IMAGE_API_LABELS[connection.apiMode]} · {canEditImageModel(entry) ? "生图/合成" : "仅生图"}</span></summary>
          <div className="image-model-fields">
            <Field label="接口类型" hint="自动按模型 ID 和服务地址预判；网关别名可手动覆盖。">
              <select className="input" aria-label={`${entry.id} 接口类型`} value={entry.apiMode} onChange={(e) => { patch(entry.id, { apiMode: e.target.value as ImageApiMode }); onBlur(); }}>
                {Object.entries(IMAGE_API_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
              </select>
            </Field>
            <Field label="模型能力">
              <select className="input" aria-label={`${entry.id} 模型能力`} value={canEditImageModel(entry) ? "edit" : "generate"}
                onChange={(e) => { patch(entry.id, { supportsEditing: e.target.value === "edit" }); onBlur(); }}>
                <option value="edit">生图 + 多图参考/编辑/合成</option>
                <option value="generate">仅文生图</option>
              </select>
            </Field>
            <Field label="用途说明" hint="提供给 Chat，帮助它决定哪个模型负责人物、背景或最终合成。">
              <input className="input" aria-label={`${entry.id} 用途说明`} value={entry.description ?? ""} placeholder="例如：擅长人物；用于最终多图合成"
                onChange={(e) => patch(entry.id, { description: e.target.value })} onBlur={onBlur} />
            </Field>
            <Field label="服务地址（可选）" hint="留空沿用上方图像连接；不同服务可单独配置。">
              <input className="input" aria-label={`${entry.id} 服务地址`} value={entry.baseUrl ?? ""} placeholder={config.baseUrl}
                onChange={(e) => patch(entry.id, { baseUrl: e.target.value })} onBlur={onBlur} />
            </Field>
            <Field label="API Key（可选）" hint="同一服务留空沿用上方密钥；不同服务请填写该服务的密钥。">
              <input className="input" type="password" aria-label={`${entry.id} API Key`} value={entry.apiKey ?? ""}
                onChange={(e) => patch(entry.id, { apiKey: e.target.value })} onBlur={onBlur} />
            </Field>
            <button type="button" className="btn sm ghost" disabled={pool.length === 1} onClick={() => { onChange(pool.filter((model) => model.id !== entry.id)); onBlur(); }}>移出模型池</button>
          </div>
        </details>;
      })}
    </div>
  );
}
