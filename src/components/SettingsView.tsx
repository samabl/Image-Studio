import { useEffect, useState } from "react";
import { Field, NumberInput, Panel, Switch } from "./ui";
import { ModelPicker } from "./ModelPicker";
import { ImageModelPool } from "./ImageModelPool";
import { SoftwareUpdate } from "./SoftwareUpdate";
import { JurySettings } from "./JurySettings";
import { availableImageModelIds, defaultImageConnection, IMAGE_API_LABELS, resolveImageApiMode } from "../lib/imageModels";
import { channelReady, useConfig, useGallery, useToast } from "../lib/store";
import { backgroundTaskStatus, configureBackgroundTasks, listModels } from "../lib/api";
import { openLocalPath } from "../lib/shell";
import { isAndroid, isDesktop } from "../lib/platform";
import type { ChatProtocol, ImageApiMode, ThemeMode } from "../types";
import { normalizeTheme, THEME_LABELS } from "../lib/theme";
import { codeRuntimeSettings } from "../lib/codeRuntime";

export function SettingsView() {
  const cfg = useConfig((s) => s.config);
  const { patchChat, patchImage, patchLinkage, patchUi, flush, resetAll, dir } = useConfig();
  const note = useToast((s) => s.push);
  const [loading, setLoading] = useState<"chat" | "image" | null>(null);
  const [background, setBackground] = useState<Awaited<ReturnType<typeof backgroundTaskStatus>> | null>(null);
  useEffect(() => {
    if (!isAndroid) return;
    let mounted = true;
    const refresh = () => { void backgroundTaskStatus().then((status) => { if (mounted) setBackground(status); }).catch(() => undefined); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (!cfg) return null;

  const fetchModels = async (kind: "chat" | "image") => {
    const ch = kind === "chat" ? cfg.chat : cfg.image;
    if (!ch.baseUrl.trim() || !ch.apiKey.trim()) {
      note("error", "请先填写 Base URL 和 API Key");
      return;
    }
    setLoading(kind);
    try {
      const models = await listModels(ch.baseUrl, ch.apiKey, kind === "chat" ? cfg.chat.protocol : resolveImageApiMode(cfg.image.apiMode, cfg.image.model, cfg.image.baseUrl) === "gemini" ? "gemini" : "openai");
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
        <SoftwareUpdate />
        {isAndroid && (
          <Panel title="后台与锁屏任务" className="settings-panel">
            <div className="hint" style={{ marginBottom: 10 }}>
              任务期间保持后台执行；网络切换或系统暂时限制联网时先等待恢复。锁屏联网需允许忽略电池优化、后台数据和厂商后台运行权限。
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span className="chip">锁屏运行：{background ? background.batteryOptimizationIgnored ? "已允许" : "待允许" : "读取中"}</span>
              <span className="chip">任务通知：{background ? background.notificationsEnabled ? "已开启" : "未开启" : "读取中"}</span>
              <span className="chip">CPU 唤醒锁：{background ? background.wakeLockHeld ? "已持有" : "未持有（空闲时正常）" : "读取中"}</span>
              <span className="chip">后台任务：{background?.activeTasks ?? 0}</span>
              <span className="chip">联网状态：{background ? background.networkBlocked ? "被系统限制" : background.networkAvailable ? "可用" : "等待连接" : "读取中"}</span>
            </div>
            {background?.lastError && <div className="error">{background.lastError}</div>}
            <button type="button" className="btn" onClick={() => void configureBackgroundTasks().catch((err: Error) => note("error", err.message))}>
              {!background?.batteryOptimizationIgnored ? "允许锁屏继续运行" : !background.notificationsEnabled ? "开启任务通知" : "后台权限设置"}
            </button>
          </Panel>
        )}
        {/* ---------------- 对话模型 ---------------- */}
        <Panel title="💬 对话模型" defaultOpen={!channelReady("chat")} className="settings-panel">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="接口协议">
              <select className="input" value={cfg.chat.protocol ?? "openai"}
                onChange={(e) => patchChat({ protocol: e.target.value as ChatProtocol, models: [] })}>
                <option value="openai">OpenAI 兼容 · Chat Completions</option>
                <option value="anthropic">Anthropic · Messages</option>
                <option value="gemini">Gemini 原生 · Generate Content</option>
              </select>
            </Field>
            <Field
              label="Base URL"
              hint={cfg.chat.protocol === "gemini" ? "Gemini 地址需包含 /v1beta" : cfg.chat.protocol === "anthropic" ? "使用 Messages 接口" : "支持根地址、/v1 或完整接口地址"}
            >
              <input
                className="input"
                value={cfg.chat.baseUrl}
                placeholder="http://10.0.0.1:3000/v1"
                onChange={(e) => patchChat({ baseUrl: e.target.value })}
                onBlur={() => void flush()}
              />
            </Field>
            <Field label="API Key" hint="保存在本机；请求时发送给所配置服务。">
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
              <ModelPicker value={cfg.chat.model} models={cfg.chat.models}
                onChange={(model) => patchChat({ model })} onBlur={() => void flush()} />
            </Field>

            <Panel title="高级参数">
            <Field label="系统提示词" hint="留空不发送 system 消息">
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
                  cfg.chat.temperature === null ? "部分模型不支持该参数" : "越低越稳定，越高越发散"
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
              >
                <NumberInput
                  className="input"
                  min={64}
                  max={200000}
                  value={cfg.chat.maxTokens}
                  onValueChange={(maxTokens) => patchChat({ maxTokens })}
                  onBlur={() => void flush()}
                />
              </Field>
              <Field label="流式输出">
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
                <NumberInput
                  className="input"
                  min={30}
                  max={1800}
                  value={cfg.chat.timeoutSecs}
                  onValueChange={(timeoutSecs) => patchChat({ timeoutSecs })}
                  onBlur={() => void flush()}
                />
              </Field>
            </div>
            </Panel>
          </div>
        </Panel>

        {/* ---------------- 图像模型 ---------------- */}
        <Panel title="🎨 图像模型" defaultOpen={!channelReady("image")} className="settings-panel">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="grid-2">
              <Field label="Base URL" hint={cfg.image.apiMode === "gemini" ? "Gemini 地址需包含 /v1beta" : undefined}>
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
              <ModelPicker value={cfg.image.model} models={availableImageModelIds(cfg.image, cfg.chat)}
                onChange={(model) => patchImage({ model })} onBlur={() => void flush()} />
            </Field>

            <Field
              label="默认接口类型"
              hint={`当前：${IMAGE_API_LABELS[defaultImageConnection(cfg.image).apiMode]}`}
            >
              <select
                className="input"
                value={cfg.image.apiMode}
                onChange={(e) => {
                  patchImage({ apiMode: e.target.value as ImageApiMode });
                  void flush();
                }}
              >
                <option value="auto">自动识别</option>
                <option value="images">images —— 标准图像接口</option>
                <option value="gemini">Gemini 原生 · Generate Content</option>
                <option value="chat">chat —— 多模态对话出图</option>
              </select>
            </Field>

            <Field label="Chat 生图模型池">
              <ImageModelPool config={cfg.image} availableModels={availableImageModelIds(cfg.image, cfg.chat)}
                onFetch={() => void fetchModels("image")} loading={loading === "image"}
                onChange={(modelPool) => patchImage({ modelPool })} onBlur={() => void flush()} />
            </Field>

            <Panel title="默认生成参数">
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
                <NumberInput
                  className="input"
                  min={1}
                  max={10}
                  value={cfg.image.n}
                  onValueChange={(n) => patchImage({ n })}
                  onBlur={() => void flush()}
                />
              </Field>
            </div>

            <Field
              label="请求超时（秒）"
              hint="慢速模型可适当延长超时"
            >
              <NumberInput
                className="input"
                min={30}
                max={3600}
                value={cfg.image.timeoutSecs}
                onValueChange={(timeoutSecs) => patchImage({ timeoutSecs })}
                onBlur={() => void flush()}
              />
            </Field>
            </Panel>
          </div>
        </Panel>

        {/* ---------------- 联动 ---------------- */}
        <Panel title="🔗 图像联动" className="settings-panel">
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
              label="允许对话模型调用图像工具"
            />
            <Switch
              checked={cfg.linkage.autoOptimizePrompt}
              onChange={(v) => {
                patchLinkage({ autoOptimizePrompt: v });
                void flush();
              }}
              label="生成前自动优化提示词"
            />
            <Field
              label="视觉 / 提示词模型"
              hint="留空使用对话模型；需支持看图"
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
        </Panel>

        <JurySettings />
        <Panel title={`代码图像编辑${cfg.codeRuntime?.enabled ? " · 已开启" : ""}`} className="settings-panel">
          <div className="settings-stack">
            <Switch checked={codeRuntimeSettings(cfg.codeRuntime).enabled} label="允许 Chat 使用内置 JavaScript 修改图片"
              onChange={(enabled) => { useConfig.getState().patchCodeRuntime({ enabled }); void flush(); }} />
            <Field label="单次执行上限（秒）"><NumberInput className="input" aria-label="代码执行上限（秒）" min={1} max={30}
              value={codeRuntimeSettings(cfg.codeRuntime).timeoutSecs} onValueChange={(timeoutSecs) => useConfig.getState().patchCodeRuntime({ timeoutSecs })} onBlur={() => void flush()} /></Field>
            <p className="hint">不开放网络、文件或应用接口；支持停止。请仅为可信模型开启，无法硬限任意 JS 内存分配。结果不自动入库。</p>
          </div>
        </Panel>

        {/* ---------------- 界面 ---------------- */}
        <Panel title="🖥 界面" className="settings-panel">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="主题">
              <select className="input" aria-label="界面主题" value={normalizeTheme(cfg.ui.theme)}
                onChange={(e) => { patchUi({ theme: e.target.value as ThemeMode }); void flush(); }}>
                {Object.entries(THEME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Switch
              checked={cfg.ui.sendOnEnter}
              onChange={(v) => {
                patchUi({ sendOnEnter: v });
                void flush();
              }}
              label="Enter 发送（Shift + Enter 换行）"
            />
            <div className="hint">Ctrl / ⌘ + Enter 发送；回复中为插话，普通 Enter 为排队。</div>
          </div>
        </Panel>

        {/* ---------------- 数据 ---------------- */}
        <Panel title="🗂 数据与存储" className="settings-panel">
          <Field label="应用数据目录" hint="配置、对话、生成结果与已入库图片">
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
            API Key 明文保存在 config.json，请勿分享该文件。
            {!isDesktop && " 卸载会删除应用私有数据，请先保存需要保留的图片。"}
          </div>
        </Panel>
      </div>
    </div>
  );
}
