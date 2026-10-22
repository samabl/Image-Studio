import { useEffect, useRef, useState } from "react";
import { Empty, Field, FileImage, Seg, Spinner, Switch } from "./ui";
import { MaskCanvas } from "./MaskCanvas";
import { showImage } from "./Overlays";
import { useConfig, useStudio, useToast, channelReady } from "../lib/store";
import { fileToAttachment } from "../lib/image";
import { copyText } from "../lib/shell";
import { readImageDataUrl } from "../lib/api";
import { SaveImageButton } from "./SaveImageButton";
import { isDesktop } from "../lib/platform";
import { defaultImageConnection } from "../lib/imageModels";
import type { GalleryItem } from "../types";

const SIZES = [
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "512x512",
  "768x1024",
  "1024x768",
  "1024x1792",
  "1792x1024",
];

export function StudioView() {
  const cfg = useConfig((s) => s.config);
  const studio = useStudio();
  const busy = studio.busy;
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const ready = channelReady("image");
  const hasRef = studio.refs.length > 0;
  const supportsMask = cfg ? defaultImageConnection(cfg.image).apiMode === "images" : false;

  // 参考图变化时自动切到编辑模式，符合直觉
  useEffect(() => {
    if (hasRef) useStudio.getState().setMode("edit");
  }, [hasRef]);

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const next = [];
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        next.push(await fileToAttachment(f));
      }
      if (next.length) studio.addRefs(next);
    } catch (err) {
      useToast.getState().push("error", (err as Error).message);
    }
  };

  return (
    <div className="studio">
      {/* ---------- 左侧控制面板 ---------- */}
      <div className="studio-panel">
        <Seg
          value={studio.mode}
          onChange={(v) => studio.setMode(v)}
          options={[
            { value: "generate", label: "文生图" },
            { value: "edit", label: "图生图 / 编辑" },
          ]}
        />

        <Field
          label="提示词"
          right={
            <span style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy || !channelReady("chat")}
                onClick={() => void studio.optimize()}
                title="用对话模型把想法扩写成专业提示词"
              >
                ✨ AI 优化
              </button>
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy || !channelReady("chat") || (!hasRef && studio.results.length === 0)}
                onClick={() => void studio.reverse()}
                title="看图反推提示词（需要对话模型支持视觉）"
              >
                🔍 反推
              </button>
            </span>
          }
          hint={
            cfg?.linkage.enabled
              ? "提示词优化与反推由「对话模型」完成 —— 这就是两个模型的联动点。"
              : "图像联动已在设置中关闭。"
          }
        >
          <textarea
            className="textarea"
            value={studio.prompt}
            placeholder="描述你想要的画面，例如：一只戴着飞行护目镜的柴犬，坐在复古螺旋桨飞机驾驶舱里，暖色夕阳，电影感"
            onChange={(e) => studio.setPrompt(e.target.value)}
          />
        </Field>

        {/* 参考图 */}
        <Field
          label={studio.mode === "generate" ? "参考图（可选，加上即变图生图）" : "参考图"}
          hint="按展示顺序编号；可在提示词里写「素材 1」「素材 2」。第一张是编辑基底，蒙版应用于第一张。"
          right={
            hasRef ? (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  studio.setRefs([]);
                  studio.setStrokes([]);
                }}
              >
                清空
              </button>
            ) : undefined
          }
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void pick(e.target.files);
              e.target.value = "";
            }}
          />
          {hasRef ? (
            <div className="ref-list">
              {studio.refs.map((r, index) => (
                <div className="ref-item" key={r.id}>
                  <img src={r.dataUrl} alt={r.name ?? ""} onClick={() => showImage({ dataUrl: r.dataUrl, title: r.name })} />
                  <span className="ref-number" title={r.name}>素材 {index + 1}</span>
                  <div className="ref-order">
                    <button type="button" disabled={busy || index === 0} title="前移素材" onClick={() => studio.moveRef(r.id, -1)}>←</button>
                    <button type="button" disabled={busy || index === studio.refs.length - 1} title="后移素材" onClick={() => studio.moveRef(r.id, 1)}>→</button>
                  </div>
                  <button
                    type="button"
                    className="kill"
                    disabled={busy}
                    onClick={() => studio.removeRef(r.id)}
                    title="移除"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div
                className="dropzone"
                style={{ width: 82, height: 82, padding: 0, display: "grid", placeItems: "center" }}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  void pick(e.dataTransfer.files);
                }}
              >
                ＋
              </div>
            </div>
          ) : (
            <div
              className={`dropzone${over ? " over" : ""}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void pick(e.dataTransfer.files);
              }}
            >
              点击选择图片，或把图片拖到这里
              <div style={{ fontSize: 11, marginTop: 4, opacity: 0.75 }}>
                {isDesktop ? "支持 PNG / JPG / WEBP" : "支持从相册或文件中选择"}
              </div>
            </div>
          )}
        </Field>

        {/* 蒙版 */}
        {hasRef && (
          <>
            <Switch
              checked={studio.maskEnabled}
              disabled={busy || !supportsMask}
              onChange={studio.setMaskEnabled}
              label={supportsMask ? "局部重绘（只改涂抹区域）" : "局部重绘需使用 images 协议"}
            />
            {studio.maskEnabled && (
              <>
                <MaskCanvas
                  image={studio.refs[0].dataUrl}
                  strokes={studio.strokes}
                  onStrokesChange={studio.setStrokes}
                  brushSize={studio.brushSize}
                  disabled={busy}
                />
                <Field label={`画笔粗细 ${(studio.brushSize * 100).toFixed(0)}`}>
                  <input
                    type="range"
                    min={0.02}
                    max={0.35}
                    step={0.01}
                    value={studio.brushSize}
                    onChange={(e) => studio.setBrushSize(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </Field>
                <div className="row">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!studio.strokes.length}
                    onClick={() => studio.setStrokes(studio.strokes.slice(0, -1))}
                  >
                    ↶ 撤销一笔
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!studio.strokes.length}
                    onClick={() => studio.setStrokes([])}
                  >
                    清空蒙版
                  </button>
                  <span className="chip">{studio.strokes.length} 笔</span>
                </div>
              </>
            )}
          </>
        )}

        {/* 参数 */}
        <div className="grid-2">
          <Field label="尺寸">
            <select
              className="input"
              value={studio.size}
              onChange={(e) => studio.patch({ size: e.target.value })}
            >
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s === "auto" ? "auto（由模型决定）" : s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="数量">
            <select
              className="input"
              value={studio.n}
              onChange={(e) => studio.patch({ n: Number(e.target.value) })}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} 张
                </option>
              ))}
            </select>
          </Field>
        </div>

        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-dim)" }}>
            高级参数
          </summary>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <Field label="质量" hint="auto 表示不下发该参数，兼容性最好">
              <select
                className="input"
                value={studio.quality}
                onChange={(e) => studio.patch({ quality: e.target.value })}
              >
                {["auto", "low", "medium", "high"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="背景">
              <select
                className="input"
                value={studio.background}
                onChange={(e) => studio.patch({ background: e.target.value })}
              >
                {["auto", "opaque", "transparent"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="输出格式">
              <select
                className="input"
                value={studio.outputFormat}
                onChange={(e) => studio.patch({ outputFormat: e.target.value })}
              >
                {["auto", "png", "jpeg", "webp"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="当前图像模型">
              <input className="input" value={cfg?.image.model ?? ""} readOnly />
            </Field>
          </div>
        </details>

        {!ready && (
          <div className="err" style={{ marginTop: 0 }}>
            图像模型尚未配置完整，请先前往「设置 → 图像模型」。
          </div>
        )}
        {studio.error && <div className="err">{studio.error}</div>}

        <button
          type="button"
          className="btn primary"
          style={{ padding: "11px 16px" }}
          disabled={busy || !ready || !studio.prompt.trim()}
          onClick={() => void studio.run()}
        >
          {busy ? (
            <>
              <Spinner /> 生成中…
            </>
          ) : studio.maskEnabled && studio.strokes.length ? (
            "按蒙版重绘"
          ) : hasRef ? (
            "生成变体"
          ) : (
            "生成图像"
          )}
        </button>

        {busy && <button type="button" className="btn danger" onClick={() => studio.stop()}>■ 停止任务</button>}
        {cfg?.linkage.autoOptimizePrompt && (
          <div className="chip accent" style={{ alignSelf: "flex-start" }}>
            已开启：出图前自动用对话模型优化提示词
          </div>
        )}
      </div>

      {/* ---------- 右侧结果区 ---------- */}
      <div className="studio-canvas">
        {busy && studio.note && (
          <div
            style={{
              padding: "10px 18px",
              borderBottom: "1px solid var(--border-soft)",
              display: "flex",
              gap: 9,
              alignItems: "center",
              color: "var(--text-dim)",
              fontSize: 12.5,
            }}
          >
            <Spinner /> {studio.note}
          </div>
        )}
        {studio.results.length === 0 ? (
          <Empty
            icon="🎨"
            title={busy ? "正在生成…" : "还没有结果"}
            hint="左侧填写提示词后点击生成。gpt-image 系列出图通常需要 20 秒到 2 分钟，请耐心等待。"
          />
        ) : (
          <div className="result-grid">
            {studio.results.map((it) => (
              <ResultCard key={it.id} item={it} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ item }: { item: GalleryItem }) {
  const { sendToStudio } = useStudio();
  const note = useToast((s) => s.push);

  const dataUrlOf = async (): Promise<string> => {
    if (item.dataUrl) return item.dataUrl;
    return readImageDataUrl(item.path);
  };

  return (
    <div className="result-card">
      <FileImage
        dataUrl={item.dataUrl}
        path={item.path}
        alt={item.prompt}
        onClick={() => showImage({ item, path: item.path, dataUrl: item.dataUrl })}
      />
      <div className="result-meta">
        <span className="chip">{item.size}</span>
        <span className="chip">{item.model}</span>
        {item.kind === "mask" && <span className="chip accent">局部重绘</span>}
        {item.kind === "edit" && <span className="chip accent">图生图</span>}
      </div>
      <div className="result-actions">
        <button
          type="button"
          className="btn sm ghost"
          onClick={() =>
            void dataUrlOf().then((u) =>
              sendToStudio({ dataUrl: u, galleryId: item.id, prompt: item.prompt }, "edit"),
            )
          }
        >
          ✎ 继续编辑
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => void copyText(item.prompt).then(() => note("success", "提示词已复制"))}
        >
          ⧉ 复制提示词
        </button>
        <SaveImageButton image={{ item, path: item.path, dataUrl: item.dataUrl }} />
      </div>
      {item.revisedPrompt && (
        <div className="result-meta" style={{ paddingTop: 0 }}>
          改写后提示词：{item.revisedPrompt.slice(0, 90)}
        </div>
      )}
    </div>
  );
}
