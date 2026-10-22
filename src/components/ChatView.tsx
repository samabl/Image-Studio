import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { Empty, FileImage, Spinner } from "./ui";
import { showImage } from "./Overlays";
import { useConfig, useSessions, useStudio, useToast, channelReady } from "../lib/store";
import { fileToAttachment } from "../lib/image";
import { SaveImageButton } from "./SaveImageButton";
import { ImageToolDetails } from "./ImageToolDetails";
import { configuredImageModels } from "../lib/imageModels";
import type { ChatAttachment, ChatMessage, GeneratedRef } from "../types";

const SUGGESTIONS = [
  "帮我画一只在雨夜街头的赛博朋克猫，霓虹灯反射在积水上",
  "把上一张图改成清晨暖色调，并加上咖啡杯",
  "先聊聊这张海报的构图，再决定要不要出图",
];

export function ChatView() {
  const cfg = useConfig((s) => s.config);
  const sessions = useSessions((s) => s.sessions);
  const currentId = useSessions((s) => s.currentId);
  const runs = useSessions((s) => s.runs);
  const run = currentId ? runs[currentId] : undefined;
  const streaming = run?.streaming;
  const busy = Boolean(run);
  const toolNote = run?.toolNote;
  const backgroundCount = Object.keys(runs).filter((id) => id !== currentId).length;
  const [showSessions, setShowSessions] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const session = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );
  const text = session?.draftText ?? "";
  const atts = session?.draftAtts ?? [];
  const setText = (value: string) => useSessions.getState().setDraftText(value);
  useEffect(() => {
    const back = (event: Event) => { if (showSessions) { event.preventDefault(); setShowSessions(false); } };
    window.addEventListener("image-studio-back", back);
    return () => window.removeEventListener("image-studio-back", back);
  }, [showSessions]);

  // 新消息 / 流式增量时贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (nearBottom || streaming) {
      el.scrollTop = el.scrollHeight;
    }
  }, [session?.messages.length, streaming?.content, streaming?.reasoning, toolNote]);

  // 自适应输入框高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const ready = channelReady("chat");
  const imageModels = cfg ? configuredImageModels(cfg.image) : [];
  const selectedImageModel = session?.imageModel ?? "";

  const submit = () => {
    const value = text.trim();
    if (!value && atts.length === 0) return;
    if (busy) return;
    void useSessions.getState().send(value, atts);
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const targetSession = currentId;
    try {
      const next: ChatAttachment[] = [];
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        next.push(await fileToAttachment(f));
      }
      if (targetSession) useSessions.getState().addDraftAtts(next, targetSession);
    } catch (err) {
      useToast.getState().push("error", (err as Error).message);
    }
  };

  return (
    <div className="chat">
      {/* 会话条 */}
      <div className="chat-head">
        <button
          type="button"
          className="btn sm"
          onClick={() => useSessions.getState().newSession()}
          title="新建对话"
        >
          ＋ 新对话
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setShowSessions((v) => !v)}
          title="历史会话"
        >
          🗂 {showSessions ? "收起" : `历史 (${sessions.length})`}
        </button>
        {backgroundCount > 0 && <span className="chip accent">后台 {backgroundCount} 个任务</span>}
        <div style={{ flex: 1 }} />
        {cfg && (
          <span className="chip" title="当前对话模型">
            {cfg.chat.model || "未配置模型"}
          </span>
        )}
        {cfg?.linkage.enabled && cfg.linkage.useTools && (
          <span className="chip accent" title="对话模型可直接调用图像模型">
            图像联动已开
          </span>
        )}
      </div>

      {cfg?.linkage.enabled && cfg.linkage.useTools && (
        <div className="chat-image-model">
          <label htmlFor="chat-image-model">生图模型</label>
          <select id="chat-image-model" className="input" value={selectedImageModel} disabled={busy}
            onChange={(e) => useSessions.getState().setImageModel(e.target.value)}>
            <option value="">自动 · Chat 从 {imageModels.length} 个模型中选择</option>
            {selectedImageModel && !imageModels.some((model) => model.id === selectedImageModel) && <option value={selectedImageModel}>{selectedImageModel}（已从模型池移除，请重选）</option>}
            {imageModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
          <button type="button" className="btn sm ghost" onClick={() => useConfig.getState().setTab("settings")}>配置模型池</button>
        </div>
      )}

      {showSessions && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "10px 16px",
            overflowX: "auto",
            borderBottom: "1px solid var(--border-soft)",
            background: "var(--bg-elev)",
          }}
        >
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-pill${s.id === currentId ? " active" : ""}`}
              onClick={() => {
                useSessions.getState().selectSession(s.id);
                setShowSessions(false);
              }}
            >
              <span className="t">{s.title || "新对话"}</span>
              {runs[s.id] && <Spinner />}
              {sessions.length > 1 && (
                <span
                  role="button"
                  title="删除"
                  style={{ opacity: 0.6 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    useSessions.getState().deleteSession(s.id);
                  }}
                >
                  ✕
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 消息区 */}
      <div className="messages" ref={scrollRef}>
        {!session || session.messages.length === 0 ? (
          <Empty
            icon="💬"
            title={ready ? "开始一段对话" : "还没有配置对话模型"}
            hint={
              ready
                ? "可以直接聊天，也可以让它出图。开启「图像联动」后，模型会自己调用图像模型并把结果贴回对话里。"
                : "请到「设置 → 对话模型」填入 Base URL、API Key 和模型名。"
            }
          >
            {ready && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="btn sm"
                    onClick={() => void useSessions.getState().send(s, [])}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </Empty>
        ) : (
          <>
            {session.messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
            {streaming && (
                <MessageRow
                  key={streaming.messageId}
                message={{
                  id: streaming.messageId,
                  role: "assistant",
                  content: streaming.content,
                  reasoning: streaming.reasoning,
                  toolCalls: streaming.toolCalls,
                  createdAt: Date.now(),
                }}
                live
              />
            )}
            {toolNote && (
              <div className="msg-wrap">
                <div className="avatar ai">🖼</div>
                <div className="bubble">
                  <div className="tool-note">
                    <Spinner />
                    {toolNote}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 输入区 */}
      <div className="composer">
        <div className="composer-inner">
          {!ready && (
            <div className="err" style={{ marginBottom: 9, marginTop: 0 }}>
              对话模型尚未配置完整，请先前往「设置」。
            </div>
          )}
          <div className="composer-box">
            {atts.length > 0 && (
              <div className="pending-att">
                {atts.map((a, index) => (
                  <div className="item" key={a.id}>
                    <img src={a.dataUrl} alt={a.name ?? ""} onClick={() => showImage({ dataUrl: a.dataUrl, title: a.name })} />
                    <span className="ref-number" title={a.name}>素材 {index + 1}</span>
                    <div className="ref-order">
                      <button type="button" disabled={index === 0} title="前移素材" onClick={() => useSessions.getState().moveDraftAtt(a.id, -1)}>←</button>
                      <button type="button" disabled={index === atts.length - 1} title="后移素材" onClick={() => useSessions.getState().moveDraftAtt(a.id, 1)}>→</button>
                    </div>
                    <button
                      type="button"
                      title="移除素材"
                      onClick={() => useSessions.getState().removeDraftAtt(a.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              placeholder={
                ready
                  ? "说点什么，或直接描述你想要的画面…（Shift + Enter 换行）"
                  : "请先配置对话模型"
              }
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) =>
                  f.type.startsWith("image/"),
                );
                if (files.length) {
                  e.preventDefault();
                  const dt = new DataTransfer();
                  files.forEach((f) => dt.items.add(f));
                  void onPickFiles(dt.files);
                }
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                const sendOnEnter = cfg?.ui.sendOnEnter ?? true;
                if (e.key === "Enter" && !e.shiftKey && sendOnEnter) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer-bar">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  void onPickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => fileRef.current?.click()}
                title="添加图片（可让模型看图）"
              >
                🖼 图片
              </button>
              {busy ? (
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => useSessions.getState().stop()}
                >
                  ■ 停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!ready || (!text.trim() && atts.length === 0)}
                  onClick={submit}
                >
                  发送 ↵
                </button>
              )}
              <div className="grow" />
              {session && session.messages.length > 0 && !busy && (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => void useSessions.getState().regenerate()}
                  title="重新生成上一条回答"
                >
                  ↻ 重试
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MessageRow({ message, live }: { message: ChatMessage; live?: boolean }) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    const imgs = message.images ?? [];
    return (
      <div className="msg-wrap">
        <div className="avatar ai">🖼</div>
        <div className="bubble">
          <div className="bubble-head">
            <span className="who">图像工具</span>
            {message.pending && <Spinner />}
          </div>
          <div className="bubble-body">
            {message.pending ? (
              <span style={{ color: "var(--text-dim)" }}>正在调用图像模型…</span>
            ) : (
              <Markdown source={message.content} />
            )}
            {imgs.length > 0 && <GeneratedImages images={imgs} />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`msg-wrap ${isUser ? "user" : ""}`}>
      <div className={`avatar ${isUser ? "user" : "ai"}`}>{isUser ? "🙋" : "✨"}</div>
      <div className="bubble">
        <div className="bubble-head">
          <span className="who">{isUser ? "你" : "助手"}</span>
          {message.model && !isUser && <span>{message.model}</span>}
          {live && <span className="chip accent">生成中…</span>}
        </div>
        <div className="bubble-body">
          {message.attachments && message.attachments.length > 0 && (
            <div className="att-grid">
              {message.attachments.map((a, index) => (
                <div key={a.id} className="att-labeled"><span className="chip">素材 {index + 1} · {a.name ?? "图片"}</span><img
                  key={a.id}
                  src={a.dataUrl}
                  alt={a.name ?? ""}
                  onClick={() => showImage({ dataUrl: a.dataUrl, title: a.name })}
                /></div>
              ))}
            </div>
          )}

          {message.reasoning && (
            <details className="reasoning">
              <summary>思考过程</summary>
              {message.reasoning}
            </details>
          )}

          {message.content ? (
            <div className={live && !message.content.endsWith("\n") ? "cursor" : undefined}>
              <Markdown source={message.content} />
            </div>
          ) : live && !message.toolCalls?.length ? (
            <span style={{ color: "var(--muted)" }}>
              <Spinner /> 正在思考…
            </span>
          ) : null}

          {message.toolCalls && message.toolCalls.length > 0 && !live && (
            <div className="image-tool-list">
              {message.toolCalls.map((tc) => (
                <ImageToolDetails key={tc.id} call={tc} labels={tc.sourceLabels} sentPrompt={tc.sentPrompt} />
              ))}
            </div>
          )}

          {message.images && message.images.length > 0 && <GeneratedImages images={message.images} />}

          {message.error && <div className="err">{message.error}</div>}
        </div>
      </div>
    </div>
  );
}

function GeneratedImages({ images }: { images: GeneratedRef[] }) {
  return (
    <div className="gen-grid">
      {images.map((img) => (
        <div className="gen-card" key={img.galleryId}>
          <FileImage
            dataUrl={img.dataUrl}
            path={img.path}
            alt={img.prompt}
            onClick={() =>
              showImage({
                dataUrl: img.dataUrl,
                path: img.path,
                title: `${img.model ?? ""} ${img.size ?? ""}`.trim(),
              })
            }
          />
          <div className="gen-actions">
            <SaveImageButton image={{ dataUrl: img.dataUrl, path: img.path }} />
            <button
              type="button"
              className="btn sm ghost"
              onClick={() =>
                useStudio.getState().sendToStudio(
                  {
                    dataUrl: img.dataUrl ?? "",
                    galleryId: img.galleryId,
                    prompt: img.prompt,
                  },
                  "edit",
                )
              }
              title="以这张图为参考图，进入图像工作室继续修改"
            >
              ✎ 送去编辑
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() =>
                useStudio.getState().sendToStudio(
                  { dataUrl: img.dataUrl ?? "", galleryId: img.galleryId, prompt: img.prompt },
                  "generate",
                )
              }
              title="以这张图为灵感做变体"
            >
              ✨ 做变体
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
