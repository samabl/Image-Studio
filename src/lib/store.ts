import { create } from "zustand";
import * as api from "./api";
import { renderMask, uid, type Stroke } from "./image";
import type {
  AppConfig,
  ChatAttachment,
  ChatConfig,
  ChatMessage,
  ChatSession,
  GalleryItem,
  ImageConfig,
  LinkageConfig,
  ToolCall,
  UiConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  text: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast["kind"], text: string) => void;
  dismiss: (id: string) => void;
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = uid("t");
    set({ toasts: [...get().toasts, { id, kind, text }] });
    const ttl = kind === "error" ? 8000 : 3200;
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (t: string) => useToast.getState().push("info", t),
  success: (t: string) => useToast.getState().push("success", t),
  error: (t: string) => useToast.getState().push("error", t),
};

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export type TabKey = "chat" | "studio" | "gallery" | "settings";

interface ConfigState {
  config: AppConfig | null;
  ready: boolean;
  tab: TabKey;
  dir: string;
  init: () => Promise<void>;
  setTab: (tab: TabKey) => void;
  patchChat: (patch: Partial<ChatConfig>) => void;
  patchImage: (patch: Partial<ImageConfig>) => void;
  patchLinkage: (patch: Partial<LinkageConfig>) => void;
  patchUi: (patch: Partial<UiConfig>) => void;
  flush: () => Promise<void>;
  resetAll: () => Promise<void>;
  reload: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useConfig = create<ConfigState>((set, get) => {
  /** 配置改动后延迟落盘，避免拖滑块时疯狂写文件。 */
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flush(), 500);
  };

  const apply = (mutate: (cfg: AppConfig) => AppConfig) => {
    const cfg = get().config;
    if (!cfg) return;
    // 用 JSON 深拷贝而不是 structuredClone：兼容较老的 Android WebView
    set({ config: mutate(JSON.parse(JSON.stringify(cfg)) as AppConfig) });
    scheduleSave();
  };

  return {
    config: null,
    ready: false,
    tab: "chat",
    dir: "",

    init: async () => {
      const [config, dir] = await Promise.all([
        api.getConfig(),
        api.dataDir().catch(() => ""),
      ]);
      set({ config, dir, ready: true });
    },

    setTab: (tab) => set({ tab }),

    patchChat: (patch) => apply((c) => ({ ...c, chat: { ...c.chat, ...patch } })),
    patchImage: (patch) => apply((c) => ({ ...c, image: { ...c.image, ...patch } })),
    patchLinkage: (patch) => apply((c) => ({ ...c, linkage: { ...c.linkage, ...patch } })),
    patchUi: (patch) => apply((c) => ({ ...c, ui: { ...c.ui, ...patch } })),

    flush: async () => {
      const cfg = get().config;
      if (!cfg) return;
      try {
        await api.saveConfig(cfg);
      } catch (err) {
        toast.error(`配置保存失败：${(err as Error).message}`);
      }
    },

    resetAll: async () => {
      const cfg = await api.resetConfig();
      set({ config: cfg });
      toast.success("已恢复默认配置");
    },

    reload: async () => {
      const cfg = await api.getConfig();
      set({ config: cfg });
    },
  };
});

/** 当前是否已经具备调用条件 */
export function channelReady(kind: "chat" | "image"): boolean {
  const cfg = useConfig.getState().config;
  if (!cfg) return false;
  const ch = kind === "chat" ? cfg.chat : cfg.image;
  return Boolean(ch.baseUrl.trim() && ch.apiKey.trim() && ch.model.trim());
}

// ---------------------------------------------------------------------------
// 图库
// ---------------------------------------------------------------------------

interface GalleryState {
  items: GalleryItem[];
  loading: boolean;
  selected: string[];
  refresh: () => Promise<void>;
  add: (items: GalleryItem[]) => void;
  remove: (ids: string[]) => Promise<void>;
  clear: () => Promise<void>;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
}

export const useGallery = create<GalleryState>((set, get) => ({
  items: [],
  loading: false,
  selected: [],

  refresh: async () => {
    set({ loading: true });
    try {
      set({ items: await api.galleryList() });
    } catch (err) {
      toast.error(`读取图库失败：${(err as Error).message}`);
    } finally {
      set({ loading: false });
    }
  },

  add: (items) => set({ items: [...items, ...get().items] }),

  remove: async (ids) => {
    await api.galleryDelete(ids);
    set({
      items: get().items.filter((i) => !ids.includes(i.id)),
      selected: get().selected.filter((id) => !ids.includes(id)),
    });
  },

  clear: async () => {
    await api.galleryClear();
    set({ items: [], selected: [] });
  },

  toggleSelect: (id) =>
    set({
      selected: get().selected.includes(id)
        ? get().selected.filter((x) => x !== id)
        : [...get().selected, id],
    }),

  clearSelection: () => set({ selected: [] }),
}));

// ---------------------------------------------------------------------------
// 图像工作室
// ---------------------------------------------------------------------------

export type StudioMode = "generate" | "edit";

interface StudioState {
  mode: StudioMode;
  prompt: string;
  refs: ChatAttachment[];
  strokes: Stroke[];
  brushSize: number;
  maskEnabled: boolean;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  n: number;
  busy: boolean;
  note: string;
  error: string | null;
  results: GalleryItem[];
  /** 迭代编辑的上游图片 id，用于在图库里串起血缘关系 */
  parentId: string | null;

  setMode: (mode: StudioMode) => void;
  setPrompt: (prompt: string) => void;
  addRefs: (refs: ChatAttachment[]) => void;
  removeRef: (id: string) => void;
  setRefs: (refs: ChatAttachment[]) => void;
  setStrokes: (strokes: Stroke[]) => void;
  setBrushSize: (size: number) => void;
  setMaskEnabled: (on: boolean) => void;
  patch: (patch: Partial<Pick<StudioState, "size" | "quality" | "background" | "outputFormat" | "n">>) => void;
  run: () => Promise<void>;
  optimize: (instruction?: string) => Promise<void>;
  reverse: (dataUrl?: string) => Promise<void>;
  /** 把任意一张图送到工作室作为参考图（图库 / 对话联动入口） */
  sendToStudio: (item: { dataUrl: string; galleryId?: string; prompt?: string }, mode?: StudioMode) => void;
  reset: () => void;
}

function imageRequestBase() {
  const cfg = useConfig.getState().config;
  if (!cfg) throw new Error("配置尚未加载");
  const img = cfg.image;
  return {
    baseUrl: img.baseUrl,
    apiKey: img.apiKey,
    model: img.model,
    apiMode: img.apiMode,
    timeoutSecs: img.timeoutSecs,
  };
}

export const useStudio = create<StudioState>((set, get) => ({
  mode: "generate",
  prompt: "",
  refs: [],
  strokes: [],
  brushSize: 0.08,
  maskEnabled: false,
  size: "1024x1024",
  quality: "auto",
  background: "auto",
  outputFormat: "auto",
  n: 1,
  busy: false,
  note: "",
  error: null,
  results: [],
  parentId: null,

  setMode: (mode) => set({ mode }),
  setPrompt: (prompt) => set({ prompt }),
  addRefs: (refs) => set({ refs: [...get().refs, ...refs], mode: "edit" }),
  removeRef: (id) => set({ refs: get().refs.filter((r) => r.id !== id) }),
  setRefs: (refs) => set({ refs }),
  setStrokes: (strokes) => set({ strokes }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setMaskEnabled: (maskEnabled) => set({ maskEnabled }),
  patch: (patch) => set(patch),
  reset: () =>
    set({
      mode: "generate",
      prompt: "",
      refs: [],
      strokes: [],
      maskEnabled: false,
      results: [],
      parentId: null,
      error: null,
      note: "",
    }),

  sendToStudio: (item, mode) => {
    set({
      refs: [{ id: uid("att"), dataUrl: item.dataUrl, galleryId: item.galleryId }],
      strokes: [],
      maskEnabled: false,
      mode: mode ?? "edit",
      parentId: item.galleryId ?? null,
      results: [],
      error: null,
      ...(item.prompt ? { prompt: item.prompt } : {}),
    });
    useConfig.getState().setTab("studio");
  },

  run: async () => {
    const state = get();
    const cfg = useConfig.getState().config;
    if (!cfg) return;

    let prompt = state.prompt.trim();
    if (!prompt) {
      toast.error("请先填写提示词");
      return;
    }

    set({ busy: true, error: null, note: "正在提交请求…", results: [] });
    try {
      // 联动：出图前先用对话模型把提示词打磨一遍
      if (cfg.linkage.enabled && cfg.linkage.autoOptimizePrompt && channelReady("chat")) {
        set({ note: "正在用对话模型优化提示词…" });
        try {
          prompt = await optimizePromptText(prompt);
          set({ prompt });
        } catch (err) {
          toast.info(`提示词优化失败，改用原文：${(err as Error).message}`);
        }
      }

      const refs = state.refs.map((r) => r.dataUrl);
      let mask: string | null = null;
      if (state.maskEnabled && state.strokes.length > 0 && refs.length > 0) {
        set({ note: "正在合成蒙版…" });
        mask = await renderMask(refs[0], state.strokes);
      }

      set({
        note: mask ? "正在按蒙版编辑图像…" : refs.length > 0 ? "正在生成变体…" : "正在生成图像…",
      });

      const items = await api.generateImage(
        {
          ...imageRequestBase(),
          prompt,
          images: refs,
          mask,
          n: state.n,
          size: state.size === "auto" ? undefined : state.size,
          quality: state.quality,
          background: state.background,
          outputFormat: state.outputFormat,
        },
        state.parentId,
      );

      set({ results: items, note: "" });
      useGallery.getState().add(items);
      toast.success(`已生成 ${items.length} 张图片`);
    } catch (err) {
      const message = (err as Error).message;
      set({ error: message, note: "" });
      toast.error(message);
    } finally {
      set({ busy: false });
    }
  },

  optimize: async (instruction) => {
    const current = get().prompt.trim();
    if (!current && !instruction) {
      toast.error("请先写下你的想法，再让 AI 润色");
      return;
    }
    const cfg = useConfig.getState().config;
    if (!cfg || !channelReady("chat")) {
      toast.error("请先在「设置」里配置对话模型");
      return;
    }
    set({ busy: true, note: "正在优化提示词…" });
    try {
      const text = await optimizePromptText(
        instruction ? `${instruction}\n\n原始描述：${current || "（无）"}` : current,
        instruction ? undefined : get().refs[0]?.dataUrl,
      );
      set({ prompt: text, note: "" });
      toast.success("提示词已优化");
    } catch (err) {
      toast.error((err as Error).message);
      set({ note: "" });
    } finally {
      set({ busy: false });
    }
  },

  reverse: async (dataUrl) => {
    const cfg = useConfig.getState().config;
    if (!cfg || !channelReady("chat")) {
      toast.error("请先在「设置」里配置对话模型");
      return;
    }
    const source = dataUrl ?? get().refs[0]?.dataUrl ?? get().results[0]?.dataUrl ?? undefined;
    if (!source) {
      toast.error("请先添加一张参考图");
      return;
    }
    set({ busy: true, note: "正在反推提示词…" });
    try {
      const text = await reversePromptText(source);
      set({ prompt: text, note: "" });
      toast.success("已根据图片反推提示词");
    } catch (err) {
      toast.error((err as Error).message);
      set({ note: "" });
    } finally {
      set({ busy: false });
    }
  },
}));

// ---------------------------------------------------------------------------
// 提示词工具（对话模型 ↔ 图像模型的粘合层）
// ---------------------------------------------------------------------------

function chatChannelConfig() {
  const cfg = useConfig.getState().config;
  if (!cfg) throw new Error("配置尚未加载");
  const lk = cfg.linkage;
  return {
    baseUrl: cfg.chat.baseUrl,
    apiKey: cfg.chat.apiKey,
    model: lk.visionModel.trim() || cfg.chat.model,
    timeoutSecs: cfg.chat.timeoutSecs,
  };
}

/** 用对话模型把口语化描述扩写成专业生图提示词。 */
export async function optimizePromptText(idea: string, imageDataUrl?: string): Promise<string> {
  const cfg = useConfig.getState().config;
  if (!cfg) throw new Error("配置尚未加载");
  const content: unknown[] = [{ type: "text", text: idea }];
  if (imageDataUrl) {
    content.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }
  return api.chatOnce({
    ...chatChannelConfig(),
    messages: [
      { role: "system", content: cfg.linkage.optimizeSystemPrompt },
      { role: "user", content: imageDataUrl ? content : idea },
    ],
    temperature: 0.8,
    maxTokens: 1024,
  });
}

/** 看图说话：把画面反推成提示词。 */
export async function reversePromptText(imageDataUrl: string): Promise<string> {
  const cfg = useConfig.getState().config;
  if (!cfg) throw new Error("配置尚未加载");
  return api.chatOnce({
    ...chatChannelConfig(),
    messages: [
      { role: "system", content: cfg.linkage.reverseSystemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "请把这张图片反推成一条生图提示词。" },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0.6,
    maxTokens: 1024,
  });
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 4;

export interface StreamingState {
  messageId: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

interface SessionState {
  sessions: ChatSession[];
  currentId: string | null;
  streaming: StreamingState | null;
  busy: boolean;
  /** 正在执行的工具说明，显示在气泡下方 */
  toolNote: string;
  cancelRef: (() => void) | null;
  /** 输入框里待发送的附件。放在 store 里，拖拽/粘贴导入才能直达对话。 */
  draftAtts: ChatAttachment[];

  init: () => Promise<void>;
  persist: () => Promise<void>;
  newSession: () => void;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  current: () => ChatSession | null;
  addDraftAtts: (atts: ChatAttachment[]) => void;
  removeDraftAtt: (id: string) => void;
  clearDraftAtts: () => void;
  send: (text: string, attachments: ChatAttachment[]) => Promise<void>;
  stop: () => void;
  regenerate: () => Promise<void>;
}

function newSessionObj(): ChatSession {
  const now = Date.now();
  return { id: uid("sess"), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

/** 内部：把一条消息转成 OpenAI 格式（可能拆成多条，如 assistant + tool）。 */
function toApiMessages(m: ChatMessage): unknown[] {
  if (m.role === "tool") {
    return [{ role: "tool", tool_call_id: m.toolCallId, content: m.content || "已完成" }];
  }
  if (m.role === "assistant") {
    const out: Record<string, unknown> = { role: "assistant", content: m.content || null };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return [out];
  }

  // user
  const atts = m.attachments ?? [];
  if (atts.length === 0) return [{ role: "user", content: m.content }];
  const parts: unknown[] = [];
  if (m.content.trim()) parts.push({ type: "text", text: m.content });
  for (const a of atts) {
    parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
  }
  return [{ role: "user", content: parts }];
}

/** 找到会话里最近一张可用作编辑源图的图片。 */
function latestImage(messages: ChatMessage[]): { dataUrl: string; galleryId?: string } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.images?.length) {
      const img = m.images[m.images.length - 1];
      return { dataUrl: img.dataUrl ?? "", galleryId: img.galleryId };
    }
    if (m.attachments?.length) {
      const a = m.attachments[m.attachments.length - 1];
      return { dataUrl: a.dataUrl, galleryId: a.galleryId };
    }
  }
  return null;
}

/** 提供给对话模型的图像工具定义。 */
export function imageTools(): unknown[] {
  return [
    {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "根据提示词生成一张新图片。当用户要求画图、出图、生成图片、想象某个画面时调用。",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "完整的图像提示词，包含主体、外观细节、环境、构图、光线与风格；英文效果通常更好。",
            },
            size: {
              type: "string",
              enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
              description: "画面比例：正方形、横向、纵向。默认 1024x1024。",
            },
            n: { type: "integer", description: "生成数量，默认 1，最多 4。" },
          },
          required: ["prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_image",
        description:
          "基于当前对话中最近的一张图片进行修改（改颜色、换风格、加/去元素等）。当用户说「把刚才那张图改成…」时调用。",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "编辑指令，说明要如何改动原图，未被提及的部分应保持不变。",
            },
          },
          required: ["prompt"],
        },
      },
    },
  ];
}

export const useSessions = create<SessionState>((set, get) => ({
  sessions: [],
  currentId: null,
  streaming: null,
  busy: false,
  toolNote: "",
  cancelRef: null,
  draftAtts: [],

  addDraftAtts: (atts) => set({ draftAtts: [...get().draftAtts, ...atts] }),
  removeDraftAtt: (id) => set({ draftAtts: get().draftAtts.filter((a) => a.id !== id) }),
  clearDraftAtts: () => set({ draftAtts: [] }),

  init: async () => {
    try {
      const raw = await api.loadState("sessions");
      if (raw) {
        const parsed = JSON.parse(raw) as { sessions: ChatSession[]; currentId: string | null };
        if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
          set({
            sessions: parsed.sessions,
            currentId: parsed.currentId ?? parsed.sessions[0].id,
          });
          return;
        }
      }
    } catch {
      // 历史损坏时直接开新会话，不阻塞启动
    }
    const s = newSessionObj();
    set({ sessions: [s], currentId: s.id });
  },

  persist: async () => {
    const { sessions, currentId } = get();
    try {
      await api.saveState("sessions", JSON.stringify({ sessions, currentId }));
    } catch {
      // 持久化失败不影响当前会话继续用
    }
  },

  newSession: () => {
    const s = newSessionObj();
    set({ sessions: [s, ...get().sessions], currentId: s.id });
    void get().persist();
  },

  selectSession: (id) => {
    set({ currentId: id });
    void get().persist();
  },

  deleteSession: (id) => {
    const rest = get().sessions.filter((s) => s.id !== id);
    const sessions = rest.length ? rest : [newSessionObj()];
    set({ sessions, currentId: sessions[0].id });
    void get().persist();
  },

  renameSession: (id, title) => {
    set({
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    });
    void get().persist();
  },

  current: () => {
    const { sessions, currentId } = get();
    return sessions.find((s) => s.id === currentId) ?? null;
  },

  stop: () => {
    get().cancelRef?.();
    set({ busy: false, toolNote: "", streaming: null, cancelRef: null });
  },

  send: async (text, attachments) => {
    const cfg = useConfig.getState().config;
    if (!cfg) return;
    if (!channelReady("chat")) {
      toast.error("请先在「设置」里配置对话模型（Base URL / API Key / 模型名）");
      return;
    }

    const session = get().current();
    if (!session) return;

    const userMsg: ChatMessage = {
      id: uid("m"),
      role: "user",
      content: text,
      attachments,
      createdAt: Date.now(),
    };

    const title =
      session.messages.length === 0 && text.trim()
        ? text.trim().slice(0, 24)
        : session.title;

    set({
      draftAtts: [],
      sessions: get().sessions.map((s) =>
        s.id === session.id
          ? { ...s, title, messages: [...s.messages, userMsg], updatedAt: Date.now() }
          : s,
      ),
    });
    void get().persist();

    await runTurn(session.id, set, get);
  },

  regenerate: async () => {
    const session = get().current();
    if (!session) return;
    // 删掉最后一条 assistant（及其后续 tool 消息）后重跑
    const msgs = [...session.messages];
    while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
    if (!msgs.length) return;
    set({
      sessions: get().sessions.map((s) =>
        s.id === session.id ? { ...s, messages: msgs, updatedAt: Date.now() } : s,
      ),
    });
    await runTurn(session.id, set, get);
  },
}));

type Setter = (
  partial:
    | Partial<SessionState>
    | ((state: SessionState) => Partial<SessionState>),
) => void;

/** 跑一轮（可能含多轮工具调用）对话。 */
async function runTurn(sessionId: string, set: Setter, get: () => SessionState): Promise<void> {
  const cfg0 = useConfig.getState().config;
  if (!cfg0) return;

  set({ busy: true, toolNote: "", streaming: null });

  const readSession = () => get().sessions.find((s) => s.id === sessionId) ?? null;

  const appendMessage = (msg: ChatMessage) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, msg], updatedAt: Date.now() } : s,
      ),
    }));
  };

  const updateMessage = (id: string, patch: Partial<ChatMessage>) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }
          : s,
      ),
    }));
  };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const cfg = useConfig.getState().config;
      if (!cfg) break;

      const session = readSession();
      if (!session) break;

      const useTools = cfg.linkage.enabled && cfg.linkage.useTools;
      const apiMessages: unknown[] = [
        ...(cfg.chat.systemPrompt.trim()
          ? [{ role: "system", content: cfg.chat.systemPrompt }]
          : []),
        ...session.messages.flatMap(toApiMessages),
      ];

      const messageId = uid("m");
      set({
        streaming: { messageId, content: "", reasoning: "", toolCalls: [] },
        toolNote: round > 0 ? "模型正在根据图像结果继续回答…" : "",
      });

      const final = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false;
        const finish = (r: { ok: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          resolve(r);
        };
        // 兜底：Rust 侧正常一定会发 done/error，但万一通道断了也要让 UI 解锁
        const guard = setTimeout(
          () => finish({ ok: false, error: "等待响应超时，已中断" }),
          (cfg.chat.timeoutSecs + 60) * 1000,
        );

        const { cancel } = api.chatStream(
          {
            baseUrl: cfg.chat.baseUrl,
            apiKey: cfg.chat.apiKey,
            model: cfg.chat.model,
            messages: apiMessages,
            temperature: cfg.chat.temperature,
            maxTokens: cfg.chat.maxTokens,
            tools: useTools ? imageTools() : null,
            timeoutSecs: cfg.chat.timeoutSecs,
          },
          (ev) => {
            const cur = get().streaming;
            if (!cur) return;
            switch (ev.type) {
              case "delta":
                set({ streaming: { ...cur, content: cur.content + ev.text } });
                break;
              case "reasoning":
                set({ streaming: { ...cur, reasoning: cur.reasoning + ev.text } });
                break;
              case "toolCalls":
                set({ streaming: { ...cur, toolCalls: ev.calls } });
                break;
              case "error":
                finish({ ok: false, error: ev.message });
                break;
              case "done":
                finish({ ok: true });
                break;
              default:
                break;
            }
          },
        );
        set({ cancelRef: cancel });
      });

      const streamed = get().streaming;
      set({ streaming: null, cancelRef: null });
      if (!streamed) break;

      const assistantMsg: ChatMessage = {
        id: messageId,
        role: "assistant",
        content: streamed.content.trim(),
        reasoning: streamed.reasoning.trim() || undefined,
        toolCalls: streamed.toolCalls.length ? streamed.toolCalls : undefined,
        model: cfg.chat.model,
        createdAt: Date.now(),
        ...(final.ok ? {} : { error: final.error }),
      };
      appendMessage(assistantMsg);

      if (!final.ok) {
        void get().persist();
        break;
      }

      if (!streamed.toolCalls.length) {
        void get().persist();
        break;
      }

      // ---- 执行图像工具 ----
      const conv = readSession();
      const source = conv ? latestImage(conv.messages) : null;
      let executed = 0;

      for (const call of streamed.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
        } catch {
          args = {};
        }

        const toolMsgId = uid("m");
        appendMessage({
          id: toolMsgId,
          role: "tool",
          content: "",
          toolCallId: call.id,
          pending: true,
          createdAt: Date.now(),
        });

        try {
          if (call.name === "generate_image") {
            const prompt = String(args.prompt ?? "").trim();
            if (!prompt) throw new Error("模型没有给出提示词");
            const count = Math.min(Math.max(Number(args.n ?? 1) || 1, 1), 4);
            set({
              toolNote: `正在调用图像模型生成：${prompt.slice(0, 60)}${
                prompt.length > 60 ? "…" : ""
              }`,
            });
            const imgCfg = useConfig.getState().config!.image;
            const sizeArg = typeof args.size === "string" && args.size !== "auto" ? args.size : undefined;
            const items = await api.generateImage({
              baseUrl: imgCfg.baseUrl,
              apiKey: imgCfg.apiKey,
              model: imgCfg.model,
              apiMode: imgCfg.apiMode,
              prompt,
              n: count,
              size: sizeArg ?? (imgCfg.size === "auto" ? undefined : imgCfg.size),
              quality: imgCfg.quality,
              background: imgCfg.background,
              outputFormat: imgCfg.outputFormat,
              timeoutSecs: imgCfg.timeoutSecs,
            });
            useGallery.getState().add(items);
            executed += 1;
            updateMessage(toolMsgId, {
              pending: false,
              content: `已生成 ${items.length} 张图片。`,
              images: items.map((it) => ({
                galleryId: it.id,
                path: it.path,
                dataUrl: it.dataUrl ?? undefined,
                prompt,
                size: it.size,
                model: it.model,
              })),
            });
          } else if (call.name === "edit_image") {
            const prompt = String(args.prompt ?? "").trim();
            if (!prompt) throw new Error("模型没有给出编辑指令");
            if (!source?.dataUrl) {
              throw new Error("当前对话里还没有可作为编辑对象的图片");
            }
            set({ toolNote: `正在按指令修改图像：${prompt.slice(0, 60)}` });
            const imgCfg = useConfig.getState().config!.image;
            const items = await api.generateImage(
              {
                baseUrl: imgCfg.baseUrl,
                apiKey: imgCfg.apiKey,
                model: imgCfg.model,
                apiMode: imgCfg.apiMode,
                prompt,
                images: [source.dataUrl],
                n: 1,
                size: imgCfg.size === "auto" ? undefined : imgCfg.size,
                quality: imgCfg.quality,
                background: imgCfg.background,
                outputFormat: imgCfg.outputFormat,
                timeoutSecs: imgCfg.timeoutSecs,
              },
              source.galleryId ?? null,
            );
            useGallery.getState().add(items);
            executed += 1;
            updateMessage(toolMsgId, {
              pending: false,
              content: `已按指令修改图像。`,
              images: items.map((it) => ({
                galleryId: it.id,
                path: it.path,
                dataUrl: it.dataUrl ?? undefined,
                prompt,
                size: it.size,
                model: it.model,
              })),
            });
          } else {
            updateMessage(toolMsgId, {
              pending: false,
              content: `未知工具：${call.name}`,
            });
          }
        } catch (err) {
          updateMessage(toolMsgId, {
            pending: false,
            content: `执行失败：${(err as Error).message}`,
          });
          toast.error((err as Error).message);
        }
      }

      void get().persist();

      if (executed === 0) break; // 全部失败就不再追问，避免死循环
      // 有成功结果 -> 回到循环，把图片结果告诉模型让它继续说话
    }
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    set({ busy: false, toolNote: "", streaming: null, cancelRef: null });
    void get().persist();
  }
}

// ---------------------------------------------------------------------------
// 启动引导
// ---------------------------------------------------------------------------

export async function bootstrap(): Promise<void> {
  await useConfig.getState().init();
  const cfg = useConfig.getState().config;
  if (cfg) {
    // 工作室默认值跟随图像通道配置
    useStudio.setState({
      size: cfg.image.size,
      quality: cfg.image.quality,
      background: cfg.image.background,
      outputFormat: cfg.image.outputFormat,
      n: cfg.image.n,
    });
  }
  await Promise.all([useGallery.getState().refresh(), useSessions.getState().init()]);
}
