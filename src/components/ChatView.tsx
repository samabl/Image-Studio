import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { Empty, FileImage, NumberInput, Panel, Spinner } from "./ui";
import { showImage } from "./Overlays";
import { useConfig, useSessions, useStudio, useToast, channelReady } from "../lib/store";
import { fileToAttachment } from "../lib/image";
import { readImageDataUrl } from "../lib/api";
import { SaveImageButton } from "./SaveImageButton";
import { AddToGalleryButton } from "./AddToGalleryButton";
import { ImageToolDetails } from "./ImageToolDetails";
import { configuredImageModels } from "../lib/imageModels";
import { GOAL_SCORERS, goalSettings } from "../lib/goal";
import { displayToolCalls, hasDisplayText, hasVisibleMessage } from "../lib/messagePresentation";
import { GoalReport } from "./GoalReport";
import { JuryReport } from "./JuryReport";
import { CodeExecutionReport } from "./CodeExecutionReport";
import { juryMembers } from "../lib/jury";
import { generatedGalleryItem } from "../lib/gallery";
import type { ChatAttachment, ChatMessage, GeneratedRef, GoalScorer, SendMode } from "../types";

const SUGGESTIONS = [
  "画一只雨夜霓虹街头的猫",
  "把上一张图改成暖色清晨",
  "先分析图片构图",
];

export function ChatView() {
  const cfg = useConfig((s) => s.config);
  const currentId = useSessions((s) => s.currentId);
  const sessionCount = useSessions((s) => s.sessions.length);
  const session = useSessions((s) => s.sessions.find((item) => item.id === currentId) ?? null);
  const run = useSessions((s) => currentId ? s.runs[currentId] : undefined);
  const streaming = run?.streaming;
  const busy = Boolean(run);
  const toolNote = run?.toolNote;
  const backgroundCount = useSessions((s) => Object.keys(s.runs).filter((id) => id !== currentId).length);
  const [showSessions, setShowSessions] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const followBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => { followBottom.current = true; setShowLatest(false); }, [currentId]);
  const text = session?.draftText ?? "";
  const atts = session?.draftAtts ?? [];
  const setText = (value: string) => useSessions.getState().setDraftText(value);
  useEffect(() => {
    const back = (event: Event) => { if (showSessions) { event.preventDefault(); setShowSessions(false); } };
    window.addEventListener("image-studio-back", back);
    return () => window.removeEventListener("image-studio-back", back);
  }, [showSessions]);

  // 合并到绘制帧；用户阅读历史时不抢滚动位置。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && followBottom.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [currentId, session?.messages, streaming?.content, streaming?.reasoning, toolNote]);
  const trackScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setShowLatest(!followBottom.current);
  };

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
  const goal = goalSettings(session?.goal);
  const toolsReady = (!!cfg?.linkage.enabled && !!cfg.linkage.useTools) || !!cfg?.codeRuntime?.enabled;
  const queued = session?.queuedMessages ?? [];
  const canSubmit = ready && (!!text.trim() || atts.length > 0);

  const submit = (mode: SendMode = busy ? "queue" : "send") => {
    const value = text.trim();
    if (!value && atts.length === 0) return;
    void useSessions.getState().send(value, atts, mode);
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
          🗂 {showSessions ? "收起" : `历史 (${sessionCount})`}
        </button>
        {backgroundCount > 0 && <span className="chip accent">后台 {backgroundCount} 个任务</span>}
        <div style={{ flex: 1 }} />
        {cfg && (
          <span className="chip" title="当前对话模型">
            {cfg.chat.model || "未配置模型"}
          </span>
        )}
      </div>

      <div className="chat-secondary">
      {session && <Panel key={session.id} title={<><span>对话选项</span>{goal.enabled && <span className="chip accent">Goal · ≥ {goal.targetScore} 分</span>}</>} className="chat-options">
      {toolsReady && (
        <div className="chat-image-model">
          <label htmlFor="chat-image-model">生图模型</label>
          <select id="chat-image-model" className="input" value={selectedImageModel} disabled={busy}
            onChange={(e) => useSessions.getState().setImageModel(e.target.value)}>
            <option value="">自动选择（{imageModels.length} 个模型）</option>
            {selectedImageModel && !imageModels.some((model) => model.id === selectedImageModel) && <option value={selectedImageModel}>{selectedImageModel}（不可用）</option>}
            {imageModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
          <button type="button" className="btn sm ghost" onClick={() => useConfig.getState().setTab("settings")}>配置模型</button>
        </div>
      )}

      <div className="chat-goal">
        <button type="button" role="switch" aria-checked={goal.enabled} className={`btn sm goal-toggle${goal.enabled ? " active" : ""}`}
          disabled={busy || (!toolsReady && !goal.enabled)}
          onClick={() => useSessions.getState().setGoal({ enabled: !goal.enabled })}>Goal 自动修正</button>
        {goal.enabled && <>
          <label>目标分数<NumberInput className="input" min={1} max={100} aria-label="Goal 目标分数" disabled={busy} value={goal.targetScore}
            onValueChange={(targetScore) => useSessions.getState().setGoal({ targetScore })} /><span>/100</span></label>
          <label>评分来源<select className="input goal-scorer" aria-label="Goal 评分来源" disabled={busy} value={goal.scorer}
            onChange={(e) => useSessions.getState().setGoal({ scorer: e.target.value as GoalScorer })}>
            {Object.entries(GOAL_SCORERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>最多修正<NumberInput className="input" min={0} max={20} aria-label="Goal 最多修正次数" disabled={busy} value={goal.maxCorrections}
            onValueChange={(maxCorrections) => useSessions.getState().setGoal({ maxCorrections })} /></label>
        </>}
        {!toolsReady && <span className="hint">需启用图像工具或内置 JS</span>}
        {goal.enabled && <span className="hint">独立评分达到目标分且符合全部明确要求才停止修正。</span>}
        {goal.enabled && goal.scorer === "jury" && (!cfg?.jury?.enabled || !juryMembers(cfg).length) && <span className="err">请启用评审团，或选择 Chat 评分。</span>}
      </div>
      {cfg?.jury?.enabled && <div className="chat-feature-status"><span className="chip">评审团 · {juryMembers(cfg).length} 位</span>
        <button type="button" className="btn sm ghost" onClick={() => useConfig.getState().setTab("settings")}>配置评审</button></div>}
      {cfg?.codeRuntime?.enabled && <span className="chip">内置 JS 图像编辑</span>}
      </Panel>}
      {run?.goalProgress && <Panel title={`Goal 进度 · 修正 ${run.goalProgress.corrections}/${run.goalProgress.maxCorrections}`} className="goal-running"><GoalReport progress={run.goalProgress} /></Panel>}

      {showSessions && <SessionList onSelect={() => setShowSessions(false)} />}
      </div>

      {/* 消息区 */}
      <div className="messages" ref={scrollRef} onScroll={trackScroll} onLoadCapture={() => {
        if (!followBottom.current) return;
        requestAnimationFrame(() => { const el = scrollRef.current; if (el && followBottom.current) el.scrollTop = el.scrollHeight; });
      }}>
        {!session || session.messages.length === 0 ? (
          <Empty
            icon="💬"
            title={ready ? "开始一段对话" : "还没有配置对话模型"}
            hint={
              ready
                ? undefined
                : "在设置中配置对话模型"
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
            <MessageHistory key={session.id} messages={session.messages} />
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

      {showLatest && <div className="chat-scroll-hint"><button type="button" className="btn sm ghost" onClick={() => {
        followBottom.current = true; setShowLatest(false);
        const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight;
      }}>↓ 回到最新消息</button></div>}

      {/* 输入区 */}
      <div className="composer">
        <div className="composer-inner">
          {queued.length > 0 && <Panel title={<><span>待发送 {queued.length}</span><span className="chip">{session?.queuePaused ? "已暂停" : "按序发送"}</span></>} className="queue-panel">
            <div className="queue-actions">
              <button type="button" className="btn sm ghost" onClick={() => session?.queuePaused ? void useSessions.getState().resumeQueue() : useSessions.getState().pauseQueue()}>
                {session?.queuePaused ? "继续队列" : "暂停队列"}
              </button>
              <button type="button" className="btn sm ghost" onClick={() => useSessions.getState().clearQueue()}>清空</button>
            </div>
            <ol className="queue-list">{queued.map((message) => <li key={message.id}>
              {message.mode === "interrupt" && <span className="chip accent">插话</span>}
              <span className="queue-text" title={message.text}>{message.text || "图片消息"}{message.attachments.length > 0 && ` · ${message.attachments.length} 张图片`}</span>
              <button type="button" className="btn sm ghost" aria-label={`移除待发送消息 ${message.text || "图片消息"}`} onClick={() => useSessions.getState().removeQueued(message.id)}>✕</button>
            </li>)}</ol>
          </Panel>}
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
                    <img src={a.dataUrl} alt={a.name ?? ""} loading="lazy" decoding="async" onClick={() => showImage({ dataUrl: a.dataUrl, title: a.name })} />
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
                  ? busy ? "继续输入，可排队或插话…" : "输入消息…"
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
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit(busy ? "interrupt" : "send");
                } else if (e.key === "Enter" && !e.shiftKey && sendOnEnter) {
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
              <div className="grow" />
              {busy ? <>
                <button type="button" className="btn sm" disabled={!canSubmit} onClick={() => submit("queue")} title="当前任务结束后发送（Enter）">排队发送</button>
                <button type="button" className="btn sm primary" disabled={!canSubmit} onClick={() => submit("interrupt")} title="停止当前回复，优先发送（Ctrl / ⌘ + Enter）">插话发送</button>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => useSessions.getState().stop()}
                >
                  ■ 停止
                </button>
              </> : (
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!canSubmit}
                  onClick={() => submit()}
                >
                  发送 ↵
                </button>
              )}
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

function SessionList({ onSelect }: { onSelect: () => void }) {
  const sessions = useSessions((state) => state.sessions);
  const currentId = useSessions((state) => state.currentId);
  const runs = useSessions((state) => state.runs);
  return <div className="session-list" aria-label="历史会话">{sessions.map((item) => <div key={item.id} className={`session-pill${item.id === currentId ? " active" : ""}`}>
    <button type="button" className="session-select" onClick={() => { useSessions.getState().selectSession(item.id); onSelect(); }}>
      <span className="t">{item.title || "新对话"}</span>{runs[item.id] && <Spinner />}
    </button>
    {sessions.length > 1 && <button type="button" className="session-delete" aria-label={`删除会话 ${item.title || "新对话"}`} title="删除"
      onClick={() => useSessions.getState().deleteSession(item.id)}>×</button>}
  </div>)}</div>;
}

const HISTORY_PAGE = 60;
const MessageHistory = memo(function MessageHistory({ messages }: { messages: ChatMessage[] }) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const visible = useMemo(() => messages.filter((message) => hasVisibleMessage(message)), [messages]);
  const anchor = useRef<{ element: HTMLElement; height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const { element, height, top } = anchor.current;
    element.scrollTop = top + element.scrollHeight - height;
    anchor.current = null;
  }, [limit]);
  return <>
    {visible.length > limit && <div className="chat-history-more"><button type="button" className="btn sm ghost" onClick={(event) => {
      const element = event.currentTarget.closest<HTMLElement>(".messages");
      if (element) anchor.current = { element, height: element.scrollHeight, top: element.scrollTop };
      setLimit((value) => value + HISTORY_PAGE);
    }}>加载更早消息（还有 {visible.length - limit} 条）</button></div>}
    {visible.slice(-limit).map((message) => <MessageRow key={message.id} message={message} />)}
  </>;
});

export const MessageRow = memo(function MessageRow({ message, live }: { message: ChatMessage; live?: boolean }) {
  if (!hasVisibleMessage(message, live)) return null;
  const visibleCalls = displayToolCalls(message.toolCalls);
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    const imgs = message.images ?? [];
    return (
      <div className="msg-wrap">
        <div className="avatar ai">🖼</div>
        <div className="bubble">
          <div className="bubble-head">
            <span className="who">{message.goalReview ? "Goal 评分" : message.juryReview ? "独立评审" : message.codeExecution ? "代码图像工具" : "图像工具"}</span>
            {message.pending && <Spinner />}
          </div>
          <div className="bubble-body">
            {message.pending ? (
              <span style={{ color: "var(--text-dim)" }}>{message.juryReview ? "正在独立评审…" : message.codeExecution ? "正在处理图片…" : "正在调用图像模型…"}</span>
            ) : message.goalReview ? <GoalReport review={message.goalReview} /> : (
              <Markdown source={message.juryReview ? message.content.split("\n评审团意见（")[0] : message.content} />
            )}
            {imgs.length > 0 && <GeneratedImages images={imgs} />}
            {message.juryReview && <JuryReport review={message.juryReview} />}
            {message.codeExecution && <CodeExecutionReport execution={message.codeExecution} />}
            {hasDisplayText(message.error) && <div className="err">{message.error}</div>}
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
                  alt={a.name ?? ""} loading="lazy" decoding="async"
                  onClick={() => showImage({ dataUrl: a.dataUrl, title: a.name })}
                /></div>
              ))}
            </div>
          )}

          {hasDisplayText(message.reasoning) && (
            <details className="reasoning">
              <summary>思考过程</summary>
              {message.reasoning}
            </details>
          )}

          {message.goalProgress && <GoalReport progress={message.goalProgress} />}
          {hasDisplayText(message.content) && !message.goalProgress ? (
            <div className={live && !message.content.endsWith("\n") ? "cursor" : undefined}>
              <Markdown source={message.content} />
            </div>
          ) : live ? (
            <span style={{ color: "var(--muted)" }}>
              <Spinner /> {message.toolCalls?.length ? "正在准备图像工具…" : "正在思考…"}
            </span>
          ) : null}

          {visibleCalls.length > 0 && !live && (
            <div className="image-tool-list">
              {visibleCalls.map((tc) => (
                <ImageToolDetails key={tc.id} call={tc} labels={tc.sourceLabels} sentPrompt={tc.sentPrompt} />
              ))}
            </div>
          )}

          {message.images && message.images.length > 0 && <GeneratedImages images={message.images} />}
          {message.juryReview && <JuryReport review={message.juryReview} />}
          {message.codeExecution && <CodeExecutionReport execution={message.codeExecution} />}

          {message.error && <div className="err">{message.error}</div>}
        </div>
      </div>
    </div>
  );
});

function GeneratedImages({ images }: { images: GeneratedRef[] }) {
  return (
    <div className="gen-grid">
      {images.map((img) => {
        const item = generatedGalleryItem(img);
        const edit = (mode: "edit" | "generate") => void (async () => {
          try {
            const dataUrl = img.dataUrl || await readImageDataUrl(img.path);
            useStudio.getState().sendToStudio({ dataUrl, galleryId: img.galleryId, prompt: img.prompt }, mode);
          } catch (error) { useToast.getState().push("error", (error as Error).message); }
        })();
        return (
        <div className="gen-card" key={img.galleryId}>
          {/* 始终走 asset 协议按需解码：图片已落盘，没必要把几 MB 的 base64 塞进 DOM 常驻内存。 */}
          <FileImage
            path={img.path}
            alt={img.prompt}
            onClick={() =>
              showImage({
                dataUrl: img.dataUrl,
                path: img.path,
                item,
                title: `${img.model ?? ""} ${img.size ?? ""}`.trim(),
              })
            }
          />
          <div className="gen-actions">
            <AddToGalleryButton item={item} />
            <SaveImageButton image={{ item, dataUrl: img.dataUrl, path: img.path }} />
          </div>
          <details className="image-more"><summary>更多</summary><div className="image-more-actions">
            <button type="button" className="btn sm ghost" onClick={() => edit("edit")}>✎ 继续编辑</button>
            <button type="button" className="btn sm ghost" onClick={() => edit("generate")}>✨ 做变体</button>
          </div></details>
        </div>
      ); })}
    </div>
  );
}
