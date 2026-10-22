import { create } from "zustand";
import * as api from "./api";
import { renderMask, uid, type Stroke } from "./image";
import { attachmentLabel, conversationMessages, imageToolInstructions, selectImageSources, userImageContent } from "./chat";
import type {
  AppConfig,
  ChatAttachment,
  ChatConfig,
  ChatMessage,
  ChatRequest,
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
  moveRef: (id: string, offset: number) => void;
  setRefs: (refs: ChatAttachment[]) => void;
  setStrokes: (strokes: Stroke[]) => void;
  setBrushSize: (size: number) => void;
  setMaskEnabled: (on: boolean) => void;
  patch: (patch: Partial<Pick<StudioState, "size" | "quality" | "background" | "outputFormat" | "n">>) => void;
  run: () => Promise<void>;
  stop: () => void;
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

let studioCancel: (() => void) | null = null;
let studioStopped = false;
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
  removeRef: (id) => {
    const state = get();
    if (state.busy) return;
    set({ refs: state.refs.filter((r) => r.id !== id), ...(state.refs[0]?.id === id ? { strokes: [], maskEnabled: false } : {}) });
  },
  moveRef: (id, offset) => {
    const state = get();
    if (state.busy) return;
    const refs = [...state.refs];
    const from = refs.findIndex((r) => r.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= refs.length) return;
    [refs[from], refs[to]] = [refs[to], refs[from]];
    set({ refs, ...(from === 0 || to === 0 ? { strokes: [], maskEnabled: false } : {}) });
  },
  setRefs: (refs) => { if (!get().busy) set({ refs, strokes: [], maskEnabled: false }); },
  setStrokes: (strokes) => set({ strokes }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setMaskEnabled: (maskEnabled) => set({ maskEnabled }),
  patch: (patch) => set(patch),
  reset: () => {
    if (get().busy) return;
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
    });
  },

  sendToStudio: (item, mode) => {
    if (get().busy) { toast.info("工作室任务仍在执行，请停止或等待完成后再编辑"); return; }
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
    if (state.busy) return;
    const cfg = useConfig.getState().config;
    if (!cfg) return;

    let prompt = state.prompt.trim();
    if (!prompt) {
      toast.error("请先填写提示词");
      return;
    }

    studioStopped = false;
    set({ busy: true, error: null, note: "正在提交请求…", results: [] });
    const background = api.startBackgroundTask();
    try {
      if (background) await background.ready;
      if (studioStopped) return;
      // 联动：出图前先用对话模型把提示词打磨一遍
      if (cfg.linkage.enabled && cfg.linkage.autoOptimizePrompt && channelReady("chat")) {
        set({ note: "正在用对话模型优化提示词…" });
        try {
          prompt = await optimizePromptText(prompt, state.refs, (cancel) => { studioCancel = cancel; });
          set({ prompt });
        } catch (err) {
          if (studioStopped) return;
          toast.info(`提示词优化失败，改用原文：${(err as Error).message}`);
        }
      }

      if (studioStopped) return;
      const refs = state.refs.map((r) => r.dataUrl);
      let mask: string | null = null;
      if (state.maskEnabled && state.strokes.length > 0 && refs.length > 0) {
        set({ note: "正在合成蒙版…" });
        mask = await renderMask(refs[0], state.strokes);
      }

      set({
        note: mask ? "正在按蒙版编辑图像…" : refs.length > 0 ? "正在生成变体…" : "正在生成图像…",
      });

      if (studioStopped) return;
      const request = api.cancellableImage(
        {
          ...imageRequestBase(),
          prompt: prompt !== state.prompt.trim() ? `${prompt}\n\n用户原始要求（必须保留）：\n${state.prompt.trim()}` : prompt,
          images: refs,
          imageLabels: state.refs.map(attachmentLabel),
          mask,
          n: state.n,
          size: state.size === "auto" ? undefined : state.size,
          quality: state.quality,
          background: state.background,
          outputFormat: state.outputFormat,
        },
        state.parentId,
      );
      studioCancel = request.cancel;
      const items = await request.promise;
      set({ results: items, note: "" });
      useGallery.getState().add(items);
      toast.success(`已生成 ${items.length} 张图片`);
    } catch (err) {
      if (studioStopped) { set({ note: "已停止" }); return; }
      const message = (err as Error).message;
      set({ error: message, note: "" });
      toast.error(message);
    } finally {
      await background?.finish();
      studioCancel = null;
      set({ busy: false });
    }
  },

  stop: () => { studioStopped = true; studioCancel?.(); set({ note: "正在停止…" }); },

  optimize: async (instruction) => {
    if (get().busy) return;
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
    studioStopped = false;
    set({ busy: true, note: "正在优化提示词…" });
    const background = api.startBackgroundTask();
    try {
      if (background) await background.ready;
      if (studioStopped) return;
      const text = await optimizePromptText(
        instruction ? `${instruction}\n\n原始描述：${current || "（无）"}` : current,
        get().refs,
        (cancel) => { studioCancel = cancel; },
      );
      if (studioStopped) return;
      set({ prompt: text, note: "" });
      toast.success("提示词已优化");
    } catch (err) {
      if (studioStopped) return;
      toast.error((err as Error).message);
      set({ note: "" });
    } finally {
      await background?.finish();
      studioCancel = null;
      set({ busy: false, note: "" });
    }
  },

  reverse: async (dataUrl) => {
    if (get().busy) return;
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
    studioStopped = false;
    set({ busy: true, note: "正在反推提示词…" });
    const background = api.startBackgroundTask();
    try {
      if (background) await background.ready;
      if (studioStopped) return;
      const text = await reversePromptText(source, (cancel) => { studioCancel = cancel; });
      if (studioStopped) return;
      set({ prompt: text, note: "" });
      toast.success("已根据图片反推提示词");
    } catch (err) {
      if (studioStopped) return;
      toast.error((err as Error).message);
      set({ note: "" });
    } finally {
      await background?.finish();
      studioCancel = null;
      set({ busy: false, note: "" });
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
    protocol: cfg.chat.protocol,
    baseUrl: cfg.chat.baseUrl,
    apiKey: cfg.chat.apiKey,
    model: lk.visionModel.trim() || cfg.chat.model,
    timeoutSecs: cfg.chat.timeoutSecs,
  };
}

/** 用对话模型把口语化描述扩写成专业生图提示词。 */
export async function optimizePromptText(idea: string, refs: ChatAttachment[] = [], onCancel?: (cancel: () => void) => void): Promise<string> {
  const cfg = useConfig.getState().config;
  if (!cfg) throw new Error("配置尚未加载");
  const content = userImageContent(idea, refs.map((a, i) => ({ ...a, label: attachmentLabel(a, i) })));
  const request: ChatRequest = {
    ...chatChannelConfig(),
    messages: [
      { role: "system", content: `${cfg.linkage.optimizeSystemPrompt}\n必须保留原文中的文字、语言、数量、构图、素材编号与对应关系、保持不变的内容和禁止项。不要擅自增加元素或改变风格。编辑时只改指定内容，其他部分保持原样。` },
      { role: "user", content: refs.length ? content : idea },
    ],
    temperature: 0.3,
    maxTokens: 2048,
  };
  if (onCancel) {
    const task = api.cancellableText(request);
    onCancel(task.cancel);
    return task.promise;
  }
  return api.chatOnce(request);
}

/** 看图说话：把画面反推成提示词。 */
export async function reversePromptText(imageDataUrl: string, onCancel?: (cancel: () => void) => void): Promise<string> {
  const cfg = useConfig.getState().config;
  if (!cfg) throw new Error("配置尚未加载");
  const request: ChatRequest = {
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
  };
  if (onCancel) {
    const task = api.cancellableText(request);
    onCancel(task.cancel);
    return task.promise;
  }
  return api.chatOnce(request);
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

export interface SessionRun {
  runId: string;
  streaming: StreamingState | null;
  toolNote: string;
  cancel: (() => void) | null;
}

interface SessionState {
  sessions: ChatSession[];
  currentId: string | null;
  runs: Record<string, SessionRun>;
  init: () => Promise<void>;
  persist: () => Promise<void>;
  newSession: () => void;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  current: () => ChatSession | null;
  setDraftText: (text: string, sessionId?: string) => void;
  addDraftAtts: (atts: ChatAttachment[], sessionId?: string) => void;
  removeDraftAtt: (id: string) => void;
  moveDraftAtt: (id: string, offset: number) => void;
  clearDraftAtts: () => void;
  send: (text: string, attachments: ChatAttachment[]) => Promise<void>;
  stop: (sessionId?: string) => void;
  regenerate: () => Promise<void>;
}

function newSessionObj(): ChatSession {
  const now = Date.now();
  return { id: uid("sess"), title: "新对话", messages: [], createdAt: now, updatedAt: now, draftText: "", draftAtts: [] };
}

// 串行保存快照，避免并发会话较旧的快照覆盖较新的历史。
let persistenceQueue: Promise<void> = Promise.resolve();
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

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
            source_image_ids: {
              type: "array", items: { type: "string" },
              description: "按输入顺序排列的图片 ID；编辑时第一张为编辑基底，其余为参考。使用消息中标记的图片 ID。",
            },
            prompt: {
              type: "string",
              description:
                "忠实表达用户要求的完整提示词，保留指定文字、语言、数量与构图，禁止擅自改变要求。",
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
          "修改、合成或组合一张或多张素材。用 source_image_ids 选择全部所需图片并指定输入顺序。未指定时使用最近一组图片。",
        parameters: {
          type: "object",
          properties: {
            source_image_ids: {
              type: "array", items: { type: "string" },
              description: "按输入顺序排列的图片 ID；编辑时第一张为编辑基底，其余为参考。使用消息中标记的图片 ID。",
            },
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

export const useSessions = create<SessionState>((set, get) => {
  const draft = (patch: Partial<ChatSession>, sessionId = get().currentId) => {
    set((state) => ({ sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, ...patch } : s) }));
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => { draftSaveTimer = null; void get().persist(); }, 500);
  };
  return {
    sessions: [], currentId: null, runs: {},
    setDraftText: (draftText, sessionId) => draft({ draftText }, sessionId),
    addDraftAtts: (atts, sessionId) => {
      const session = get().sessions.find((s) => s.id === (sessionId ?? get().currentId));
      if (session) draft({ draftAtts: [...(session.draftAtts ?? []), ...atts] }, session.id);
    },
    removeDraftAtt: (id) => draft({ draftAtts: (get().current()?.draftAtts ?? []).filter((a) => a.id !== id) }),
    moveDraftAtt: (id, offset) => {
      const atts = [...(get().current()?.draftAtts ?? [])];
      const from = atts.findIndex((a) => a.id === id);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= atts.length) return;
      [atts[from], atts[to]] = [atts[to], atts[from]];
      draft({ draftAtts: atts });
    },
    clearDraftAtts: () => draft({ draftAtts: [] }),
    init: async () => {
      try {
        const raw = await api.loadState("sessions");
        if (raw) {
          const parsed = JSON.parse(raw) as { sessions: ChatSession[]; currentId: string | null };
          if (Array.isArray(parsed.sessions) && parsed.sessions.length) {
            set({ sessions: parsed.sessions, currentId: parsed.sessions.some((s) => s.id === parsed.currentId) ? parsed.currentId : parsed.sessions[0].id });
            return;
          }
        }
      } catch { /* 历史损坏时开新会话。 */ }
      const session = newSessionObj();
      set({ sessions: [session], currentId: session.id });
    },
    persist: () => {
      if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
      const { sessions, currentId } = get();
      const value = JSON.stringify({ sessions, currentId });
      persistenceQueue = persistenceQueue.catch(() => undefined).then(() => api.saveState("sessions", value)).catch((err) => {
        toast.error(`对话保存失败：${(err as Error).message}`);
      });
      return persistenceQueue;
    },
    newSession: () => {
      const s = newSessionObj();
      set({ sessions: [s, ...get().sessions], currentId: s.id });
      void get().persist();
    },
    selectSession: (id) => {
      if (!get().sessions.some((s) => s.id === id)) return;
      set({ currentId: id });
      void get().persist();
    },
    deleteSession: (id) => {
      get().stop(id);
      const rest = get().sessions.filter((s) => s.id !== id);
      const sessions = rest.length ? rest : [newSessionObj()];
      set({ sessions, currentId: get().currentId === id ? sessions[0].id : get().currentId });
      void get().persist();
    },
    renameSession: (id, title) => {
      set({ sessions: get().sessions.map((s) => s.id === id ? { ...s, title } : s) });
      void get().persist();
    },
    current: () => get().sessions.find((s) => s.id === get().currentId) ?? null,
    stop: (id) => {
      const sessionId = id ?? get().currentId;
      if (!sessionId) return;
      get().runs[sessionId]?.cancel?.();
    },
    send: async (text, attachments) => {
      const session = get().current();
      if (!session || get().runs[session.id]) return;
      if (!channelReady("chat")) { toast.error("请先配置对话模型"); return; }
      const userMsg: ChatMessage = { id: uid("m"), role: "user", content: text, attachments, createdAt: Date.now() };
      set({ sessions: get().sessions.map((s) => s.id === session.id ? {
        ...s, title: s.messages.length ? s.title : text.trim().slice(0, 24) || "图片对话",
        messages: [...s.messages, userMsg], draftText: "", draftAtts: [], updatedAt: Date.now(),
      } : s) });
      void get().persist();
      await runTurn(session.id, set, get);
    },
    regenerate: async () => {
      const session = get().current();
      if (!session || get().runs[session.id] || !channelReady("chat")) return;
      const msgs = [...session.messages];
      while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
      if (!msgs.length) return;
      set({ sessions: get().sessions.map((s) => s.id === session.id ? { ...s, messages: msgs, updatedAt: Date.now() } : s) });
      await runTurn(session.id, set, get);
    },
  };
});

type Setter = (partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)) => void;

async function runTurn(sessionId: string, set: Setter, get: () => SessionState): Promise<void> {
  const cfg = useConfig.getState().config;
  if (!cfg || get().runs[sessionId]) return;
  const runId = uid("run");
  let stopped = false;
  let abort: (() => void) | null = null;
  const cancel = () => { stopped = true; abort?.(); };
  set((state) => ({ runs: { ...state.runs, [sessionId]: { runId, streaming: null, toolNote: "", cancel } } }));
  const active = () => !stopped && get().runs[sessionId]?.runId === runId && get().sessions.some((s) => s.id === sessionId);
  const patchRun = (patch: Partial<SessionRun>) => {
    if (get().runs[sessionId]?.runId !== runId) return;
    set((state) => ({ runs: { ...state.runs, [sessionId]: { ...state.runs[sessionId], ...patch } } }));
  };
  const readSession = () => get().sessions.find((s) => s.id === sessionId);
  const append = (msg: ChatMessage) => set((state) => ({ sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, messages: [...s.messages, msg], updatedAt: Date.now() } : s) }));
  const update = (id: string, patch: Partial<ChatMessage>) => set((state) => ({ sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, messages: s.messages.map((m) => m.id === id ? { ...m, ...patch } : m) } : s) }));
  const background = api.startBackgroundTask();
  try {
    if (background) await background.ready;
    for (let round = 0; round <= MAX_TOOL_ROUNDS && active(); round += 1) {
      const session = readSession();
      if (!session) break;
      const useTools = cfg.linkage.enabled && cfg.linkage.useTools && round < MAX_TOOL_ROUNDS;
      const history = conversationMessages(session.messages);
      const messageId = uid("m");
      patchRun({ streaming: { messageId, content: "", reasoning: "", toolCalls: [] }, toolNote: round ? "正在检查图像结果…" : "" });
      const final = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false;
        const finish = (result: { ok: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          abort = null;
          resolve(result);
        };
        const guard = setTimeout(() => { stream.cancel(); finish({ ok: false, error: "等待响应超时" }); }, (cfg.chat.timeoutSecs + 60) * 1000);
        const stream = api.chatStream({
          protocol: cfg.chat.protocol, stream: cfg.chat.stream,
          baseUrl: cfg.chat.baseUrl, apiKey: cfg.chat.apiKey, model: cfg.chat.model,
          messages: [
            ...(cfg.chat.systemPrompt.trim() ? [{ role: "system", content: cfg.chat.systemPrompt }] : []),
            ...(cfg.linkage.enabled && cfg.linkage.useTools ? [{ role: "system", content: imageToolInstructions(session.messages) }] : []),
            ...history,
          ],
          temperature: cfg.chat.temperature, maxTokens: cfg.chat.maxTokens,
          tools: useTools ? imageTools() : null, timeoutSecs: cfg.chat.timeoutSecs,
        }, (event) => {
          if (settled || !active()) return;
          const cur = get().runs[sessionId]?.streaming;
          if (!cur || cur.messageId !== messageId) return;
          if (event.type === "delta") patchRun({ streaming: { ...cur, content: cur.content + event.text } });
          else if (event.type === "reasoning") patchRun({ streaming: { ...cur, reasoning: cur.reasoning + event.text } });
          else if (event.type === "toolCalls") patchRun({ streaming: { ...cur, toolCalls: event.calls } });
          else if (event.type === "error") finish({ ok: false, error: event.message });
          else if (event.type === "done") finish({ ok: true });
        });
        abort = () => { stream.cancel(); finish({ ok: false, error: "已停止" }); };
        if (stopped) abort();
      });
      const streamed = get().runs[sessionId]?.streaming;
      patchRun({ streaming: null });
      if (!streamed) break;
      // 停止时保留已生成文字，丢弃未执行的工具调用。
      append({ id: messageId, role: "assistant", content: streamed.content.trim(), reasoning: streamed.reasoning.trim() || undefined,
        toolCalls: final.ok && streamed.toolCalls.length ? streamed.toolCalls : undefined,
        model: cfg.chat.model, createdAt: Date.now(), ...(final.ok ? {} : { error: final.error }) });
      if (!final.ok || !active() || !streamed.toolCalls.length) break;
      const conv = readSession();
      if (!conv) break;
      const original = [...conv.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      for (const call of streamed.toolCalls) {
        const toolId = uid("m");
        append({ id: toolId, role: "tool", content: "", toolCallId: call.id, pending: true, createdAt: Date.now() });
        try {
          if (!active()) throw new Error("已停止");
          if (call.name !== "generate_image" && call.name !== "edit_image") throw new Error(`未知工具：${call.name}`);
          const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
          const prompt = String(args.prompt ?? "").trim();
          if (!prompt) throw new Error("模型没有给出图像指令");
          const sources = call.name === "edit_image" ? selectImageSources(conv.messages, args.source_image_ids) :
            args.source_image_ids !== undefined ? selectImageSources(conv.messages, args.source_image_ids) : [];
          if (call.name === "edit_image" && !sources.length) throw new Error("没有选择可用的参考图片");
          const images = await Promise.all(sources.map((image) => image.dataUrl || (image.path ? api.readImageDataUrl(image.path) : Promise.reject(new Error("参考图片无法读取")))));
          if (!active()) throw new Error("已停止");
          patchRun({ toolNote: `${sources.length ? `正在使用 ${sources.length} 张素材编辑` : "正在生成图片"}：${prompt.slice(0, 60)}` });
          const imgCfg = cfg.image;
          const request = api.cancellableImage({
            baseUrl: imgCfg.baseUrl, apiKey: imgCfg.apiKey, model: imgCfg.model, apiMode: imgCfg.apiMode,
            prompt: `${prompt}\n\n用户原始要求（必须保留文字、数量、构图、素材对应关系与禁止项）：\n${original}`,
            images, imageLabels: sources.map((source) => source.label),
            n: Math.min(Math.max(Math.floor(Number(args.n ?? 1)) || 1, 1), 4),
            size: typeof args.size === "string" && args.size !== "auto" ? args.size : imgCfg.size === "auto" ? undefined : imgCfg.size,
            quality: imgCfg.quality, background: imgCfg.background, outputFormat: imgCfg.outputFormat, timeoutSecs: imgCfg.timeoutSecs,
          }, sources[0]?.galleryId);
          abort = request.cancel;
          if (stopped) abort();
          const items = await request.promise;
          abort = null;
          useGallery.getState().add(items);
          update(toolId, { pending: false, content: `已生成 ${items.length} 张图片。`, images: items.map((item) => ({
            galleryId: item.id, path: item.path, dataUrl: item.dataUrl ?? undefined, prompt: item.prompt, size: item.size, model: item.model,
          })) });
        } catch (err) {
          abort = null;
          const error = stopped ? "已停止" : (err as Error).message;
          update(toolId, { pending: false, content: `执行失败：${error}` });
          if (!stopped) toast.error(error);
        }
      }
      void get().persist();
    }
  } catch (err) {
    if (!stopped) toast.error((err as Error).message);
  } finally {
    await background?.finish();
    if (get().runs[sessionId]?.runId === runId) {
      set((state) => { const runs = { ...state.runs }; delete runs[sessionId]; return { runs }; });
    }
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
