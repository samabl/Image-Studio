import { useState } from "react";
import { Field, Switch } from "./ui";
import { useConfig, useGallery, useToast } from "../lib/store";
import { listModels } from "../lib/api";
import { openLocalPath } from "../lib/shell";
import { isDesktop } from "../lib/platform";

export function SettingsView() {
  const cfg = useConfig((s) => s.config);
  const { patchChat, patchImage, patchLinkage, patchUi, flush, resetAll, dir } = useConfig();
  const note = useToast((s) => s.push);
  const [loading, setLoading] = useState<"chat" | "image" | null>(null);

  if (!cfg) return null;

  const fetchModels = async (kind: "chat" | "image") => {
    const ch = kind === "chat" ? cfg.chat : cfg.image;
    if (!ch.baseUrl.trim() || !ch.apiKey.trim()) {
      note("error", "请先填写 Base URL 和 API Key");
      return;
    }
    setLoading(kind);
    try {
      const models = await listModels(ch.baseUrl, ch.apiKey);
      if (models.length === 0) {
        note("error", "接口没有返回任何模型");
      } else {
        if (kind === "chat") patchChat({ models });
        else patchImage({ models });
        note("success", `获取到 ${models.length} 个模型`);
      }
    } catch (err) {
      note("error", (err as Error).message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="settings">
      <div className="settings-inner">
        {/* ---------------- 对话模型 ---------------- */}
        <div className="card">
          <div className="card-title">
            💬 对话模型
            <span className="tag">用于聊天、看图、优化提示词</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field
              label="Base URL"
              hint="填到 /v1 或不填都可以：http://host:3000、http://host:3000/v1、或完整端点都能识别。"
            >
              <input
                className="input"
                value={cfg.chat.baseUrl}
                placeholder="http://10.0.0.1:3000/v1"
                onChange={(e) => patchChat({ baseUrl: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>
            <Field label="API Key" hint="仅保存在本机应用数据目录的 config.json 中，不会上传到任何第三方。">
              <input
                className="input"
                type="password"
                value={cfg.chat.apiKey}
                placeholder="sk-..."
                onChange={(e) => patchChat({ apiKey: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>
            <Field
              label="模型"
              right={
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={loading === "chat"}
                  onClick={() => void fetchModels("chat")}
                >
                  {loading === "chat" ? "获取中…" : "↻ 拉取模型列表"}
                </button>
              }
            >
              <input
                className="input"
                list="chat-models"
                value={cfg.chat.model}
                placeholder="gpt-5.6-luna"
                onChange={(e) => patchChat({ model: e.target.value })}
                onBlur={() => void flush()}
              />
              <datalist id="chat-models">
                {cfg.chat.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>

            <Field label="系统提示词" hint="决定助手的角色与行为。留空则不发送 system 消息。">
              <textarea
                className="textarea"
                style={{ minHeight: 110 }}
                value={cfg.chat.systemPrompt}
                onChange={(e) => patchChat({ systemPrompt: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>

            <div className="grid-2">
              <Field
                label="采样温度"
                hint={
                  cfg.chat.temperature === null
                    ? "当前不下发该参数。gpt-5.6 等推理模型拒绝 temperature，需要时再打开。"
                    : "数值越低越稳定，越高越发散。"
                }
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <Switch
                    checked={cfg.chat.temperature !== null}
                    onChange={(v) => {
                      patchChat({ temperature: v ? 0.7 : null });
                      void flush();
                    }}
                    label={cfg.chat.temperature === null ? "不发送（推荐）" : "自定义"}
                  />
                  {cfg.chat.temperature !== null && (
                    <div className="row">
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={cfg.chat.temperature}
                        onChange={(e) => patchChat({ temperature: Number(e.target.value) })}
                        onMouseUp={() => void flush()}
                        onTouchEnd={() => void flush()}
                        style={{ flex: 1 }}
                      />
                      <span className="chip">{cfg.chat.temperature.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </Field>
              <Field
                label="最大输出 Tokens"
                hint="若网关要求新命名，会自动改用 max_completion_tokens 重试。"
              >
                <input
                  className="input"
                  type="number"
                  min={64}
                  max={200000}
                  value={cfg.chat.maxTokens}
                  onChange={(e) => patchChat({ maxTokens: Number(e.target.value) || 4096 })}
                  onBlur={() => void flush()}
                />
              </Field>
              <Field label="流式输出" hint="关闭后一次性返回完整回答。">
                <Switch
                  checked={cfg.chat.stream}
                  onChange={(v) => {
                    patchChat({ stream: v });
                    void flush();
                  }}
                  label={cfg.chat.stream ? "开启" : "关闭"}
                />
              </Field>
              <Field label="请求超时（秒）">
                <input
                  className="input"
                  type="number"
                  min={30}
                  max={1800}
                  value={cfg.chat.timeoutSecs}
                  onChange={(e) => patchChat({ timeoutSecs: Number(e.target.value) || 300 })}
                  onBlur={() => void flush()}
                />
              </Field>
            </div>
          </div>
        </div>

        {/* ---------------- 图像模型 ---------------- */}
        <div className="card">
          <div className="card-title">
            🎨 图像模型
            <span className="tag">用于文生图 / 图生图 / 局部重绘</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="grid-2">
              <Field label="Base URL" hint="可以和对话模型不同，完全独立配置。">
                <input
                  className="input"
                  value={cfg.image.baseUrl}
                  placeholder="http://10.0.0.1:3000/v1"
                  onChange={(e) => patchImage({ baseUrl: e.target.value })}
                  onBlur={() => void flush()}
                />
              </Field>
              <Field label="API Key">
                <input
                  className="input"
                  type="password"
                  value={cfg.image.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => patchImage({ apiKey: e.target.value })}
                  onBlur={() => void flush()}
                />
              </Field>
            </div>

            <Field
              label="模型"
              right={
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={loading === "image"}
                  onClick={() => void fetchModels("image")}
                >
                  {loading === "image" ? "获取中…" : "↻ 拉取模型列表"}
                </button>
              }
            >
              <input
                className="input"
                list="image-models"
                value={cfg.image.model}
                placeholder="gpt-image-2"
                onChange={(e) => patchImage({ model: e.target.value })}
                onBlur={() => void flush()}
              />
              <datalist id="image-models">
                {cfg.image.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>

            <Field
              label="接口形态"
              hint="images：走 /images/generations 与 /images/edits（gpt-image 系列）。chat：走 /chat/completions 的 modalities 出图（Gemini 系图像模型）。"
            >
              <select
                className="input"
                value={cfg.image.apiMode}
                onChange={(e) => {
                  patchImage({ apiMode: e.target.value as "images" | "chat" });
                  void flush();
                }}
              >
                <option value="images">images —— 标准图像接口</option>
                <option value="chat">chat —— 多模态对话出图</option>
              </select>
            </Field>

            <div className="grid-2">
              <Field label="默认尺寸">
                <input
                  className="input"
                  value={cfg.image.size}
                  onChange={(e) => patchImage({ size: e.target.value })}
                  onBlur={() => void flush()}
                />
              </Field>
              <Field label="默认数量">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={cfg.image.n}
                  onChange={(e) => patchImage({ n: Number(e.target.value) || 1 })}
                  onBlur={() => void flush()}
                />
              </Field>
            </div>

            <Field
              label="请求超时（秒）"
              hint="gpt-image-2.5 这类模型单张可能超过 2 分钟，建议 600 秒以上。"
            >
              <input
                className="input"
                type="number"
                min={30}
                max={3600}
                value={cfg.image.timeoutSecs}
                onChange={(e) => patchImage({ timeoutSecs: Number(e.target.value) || 600 })}
                onBlur={() => void flush()}
              />
            </Field>
          </div>
        </div>

        {/* ---------------- 联动 ---------------- */}
        <div className="card">
          <div className="card-title">
            🔗 对话 ⇄ 图像 联动
            <span className="tag">两个模型如何互相调用</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Switch
              checked={cfg.linkage.enabled}
              onChange={(v) => {
                patchLinkage({ enabled: v });
                void flush();
              }}
              label="启用联动能力"
            />
            <Switch
              checked={cfg.linkage.useTools}
              onChange={(v) => {
                patchLinkage({ useTools: v });
                void flush();
              }}
              label="允许对话模型直接调用图像工具（function calling）"
            />
            <Switch
              checked={cfg.linkage.autoOptimizePrompt}
              onChange={(v) => {
                patchLinkage({ autoOptimizePrompt: v });
                void flush();
              }}
              label="出图前自动用对话模型润色提示词"
            />
            <Field
              label="视觉 / 提示词模型"
              hint="留空则沿用上面的对话模型。反推图片、图片优化时会用这个模型（需要支持视觉输入）。"
            >
              <input
                className="input"
                value={cfg.linkage.visionModel}
                placeholder="留空 = 使用对话模型"
                onChange={(e) => patchLinkage({ visionModel: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>
            <Field label="提示词优化 System Prompt">
              <textarea
                className="textarea"
                value={cfg.linkage.optimizeSystemPrompt}
                onChange={(e) => patchLinkage({ optimizeSystemPrompt: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>
            <Field label="图像反推 System Prompt">
              <textarea
                className="textarea"
                value={cfg.linkage.reverseSystemPrompt}
                onChange={(e) => patchLinkage({ reverseSystemPrompt: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>
          </div>
        </div>

        {/* ---------------- 界面 ---------------- */}
        <div className="card">
          <div className="card-title">🖥 界面</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Switch
              checked={cfg.ui.sendOnEnter}
              onChange={(v) => {
                patchUi({ sendOnEnter: v });
                void flush();
              }}
              label="Enter 发送（关闭后用 Ctrl/⌘ + Enter 发送）"
            />
          </div>
        </div>

        {/* ---------------- 数据 ---------------- */}
        <div className="card">
          <div className="card-title">🗂 数据与存储</div>
          <Field label="应用数据目录" hint="配置、对话历史与图库原图都保存在这里。">
            <input className="input" value={dir} readOnly />
          </Field>
          <div className="row" style={{ marginTop: 12 }}>
            {isDesktop && (
              <button
                type="button"
                className="btn sm"
                onClick={() => void openLocalPath(dir).catch((e) => note("error", e.message))}
              >
                打开目录
              </button>
            )}
            <button
              type="button"
              className="btn sm danger"
              onClick={() => {
                void resetAll().then(() => {
                  useGallery.getState().refresh().catch(() => undefined);
                });
              }}
            >
              恢复默认配置
            </button>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            提示：API Key 以明文存放在 config.json 中。请勿把该文件分享给他人；在共享电脑上使用后建议清空。
            {!isDesktop && " 安卓端图片保存在应用私有目录，卸载应用会一并删除。"}
          </div>
        </div>
      </div>
    </div>
  );
}
