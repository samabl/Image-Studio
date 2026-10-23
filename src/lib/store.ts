import { create } from "zustand";
import * as api from "./api";
import { renderMask, uid, type Stroke } from "./image";
import { attachmentLabel, conversationMessages, imageCatalogInstructions, imageToolInstructions, selectImageSources, userImageContent } from "./chat";
import { canEditImageModel, configuredImageModels, defaultImageConnection, imageModelConnection, imageModelInstructions, selectImageModel } from "./imageModels";
import { imageToolSize } from "./imageSize";
import { GOAL_LEVELS, goalInstructions, goalReviewTool, goalSettings, imageFailureMessage, parseGoalReview } from "./goal";
import { juryFeedback, juryInstructions, juryMembers, juryReviewTool, jurySafeText, jurySettings, startJuryReview } from "./jury";
import { codeImageInstructions, codeImageTool, codeRuntimeSettings, startCodeEdit } from "./codeRuntime";
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
  GoalProgress,
  GoalSettings,
  ImageRequest,
  QueuedMessage,
  SendMode,
  JuryConfig,
  JuryReview,
  CodeRuntimeConfig,
  CodeExecution,
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
  patchJury: (patch: Partial<JuryConfig>) => void;
  patchCodeRuntime: (patch: Partial<CodeRuntimeConfig>) => void;
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
    patchJury: (patch) => apply((c) => ({ ...c, jury: { ...jurySettings(c.jury), ...patch } })),
    patchCodeRuntime: (patch) => apply((c) => ({ ...c, codeRuntime: codeRuntimeSettings({ ...codeRuntimeSettings(c.codeRuntime), ...patch }) })),
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
  let ch;
  try { ch = kind === "chat" ? cfg.chat : defaultImageConnection(cfg.image); }
  catch { return false; }
  return Boolean(ch.baseUrl.trim() && ch.apiKey.trim() && ch.model.trim());
}

// ---------------------------------------------------------------------------
// 图库
// ---------------------------------------------------------------------------

interface GalleryState {
  items: GalleryItem[];
  loading: boolean;
  selected: string[];
  archiving: string[];
  refresh: () => Promise<void>;
  add: (items: GalleryItem[]) => void;
  archive: (item: GalleryItem) => Promise<GalleryItem>;
  remove: (ids: string[]) => Promise<void>;
  clear: () => Promise<void>;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
}

const archiveRequests = new Map<string, Promise<GalleryItem>>();
export const useGallery = create<GalleryState>((set, get) => ({
  items: [],
  loading: false,
  selected: [],
  archiving: [],

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

  add: (items) => set({ items: [...items, ...get().items.filter((old) => !items.some((item) => item.id === old.id))] }),

  archive: async (item) => {
    const existing = get().items.find((saved) => saved.id === item.id);
    if (existing) return existing;
    const pending = archiveRequests.get(item.id);
    if (pending) return pending;
    set({ archiving: [...get().archiving, item.id] });
    const request = api.galleryArchive(item).then((saved) => {
      get().add([saved]);
      return saved;
    }).finally(() => {
      archiveRequests.delete(item.id);
      set({ archiving: get().archiving.filter((id) => id !== item.id) });
    });
    archiveRequests.set(item.id, request);
    return request;
  },

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
  return defaultImageConnection(cfg.image);
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
      if (studioStopped) return;
      set({ results: items, note: "" });
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
  goalProgress?: GoalProgress;
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
  setImageModel: (model: string) => void;
  setGoal: (patch: Partial<GoalSettings>) => void;
  send: (text: string, attachments: ChatAttachment[], mode?: SendMode) => Promise<void>;
  removeQueued: (id: string) => void;
  clearQueue: () => void;
  pauseQueue: () => void;
  resumeQueue: () => Promise<void>;
  /** 当前任务完成后只推进它所属会话的队列。 */
  advanceQueue: (sessionId: string) => Promise<void>;
  stop: (sessionId?: string) => void;
  regenerate: () => Promise<void>;
}

function newSessionObj(): ChatSession {
  const now = Date.now();
  return { id: uid("sess"), title: "新对话", messages: [], createdAt: now, updatedAt: now, draftText: "", draftAtts: [], queuedMessages: [], queuePaused: false };
}

// 串行保存快照，避免并发会话较旧的快照覆盖较新的历史。
let persistenceQueue: Promise<void> = Promise.resolve();
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 提供给对话模型的图像工具定义。 */
export function imageTools(config?: ImageConfig, pinned = ""): unknown[] {
  const pool = config ? configuredImageModels(config) : [];
  const ids = pool.map((model) => model.id);
  const editIds = pool.filter((model) => canEditImageModel(model) && (!pinned || model.id === pinned)).map((model) => model.id);
  const modelParameter = {
    type: "string",
    ...(ids.length ? { enum: pinned && ids.includes(pinned) ? [pinned] : ids } : {}),
    description: pinned ? `当前会话指定的生图模型：${pinned}` : "从已启用的生图模型中选择，填写准确模型 ID。",
  };
  const stageParameter = { type: "string", enum: ["asset", "final"], description: "asset：分工中的中间素材，只执行当前部件任务；final：最终成图/合成。默认 final。" };
  const sizeParameter = { type: "string", description: "输出尺寸，使用服务支持的宽x高字符串，如 1024x1024、1536x1024、1024x1536、2048x2048 或 3840x2160；auto 交给图像模型决定。未提供时沿用用户设置。Gemini/兼容 Chat 按尺寸转换为比例和分辨率档位，实际尺寸由服务决定。" };
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
            model: modelParameter,
            stage: stageParameter,
            source_image_ids: {
              type: "array", items: { type: "string" },
              description: "按输入顺序排列的图片 ID；编辑时第一张为编辑基底，其余为参考。使用消息中标记的图片 ID。",
            },
            prompt: {
              type: "string",
              description:
                "忠实表达用户要求的完整提示词，保留指定文字、语言、数量与构图，禁止擅自改变要求。",
            },
            size: sizeParameter,
            n: { type: "integer", description: "生成数量，默认 1，最多 4。" },
          },
          required: ids.length > 1 ? ["prompt", "model"] : ["prompt"],
        },
      },
    },
    ...(!config || editIds.length ? [{
      type: "function",
      function: {
        name: "edit_image",
        description:
          "修改、合成或组合一张或多张素材。用 source_image_ids 选择全部所需图片并指定输入顺序。未指定时使用最近一组图片。",
        parameters: {
          type: "object",
          properties: {
            model: { ...modelParameter, ...(config ? { enum: editIds } : {}) },
            stage: stageParameter,
            size: sizeParameter,
            n: { type: "integer", description: "输出数量，默认 1，最多 4。" },
            source_image_ids: {
              type: "array", items: { type: "string" },
              description: "按输入顺序排列的图片 ID；编辑时第一张为编辑基底，其余为参考。使用消息中标记的图片 ID。",
            },
            prompt: {
              type: "string",
              description: "编辑指令，说明要如何改动原图，未被提及的部分应保持不变。",
            },
          },
          required: ids.length > 1 ? ["prompt", "model"] : ["prompt"],
        },
      },
    }] : []),
    {
      type: "function",
      function: {
        name: "retry_image",
        description: "由 Chat 决定重试失败的生图/编辑调用，或改用其他已启用模型。自动保留失败请求的完整指令、全部素材和顺序、尺寸及输出参数。只接受当前轮实际失败的调用 ID。",
        parameters: {
          type: "object",
          properties: {
            failed_call_id: { type: "string", description: "失败工具响应中给出的 failed_call_id。" },
            model: modelParameter,
          },
          required: ["failed_call_id", "model"],
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
  const canSend = (session: ChatSession) => {
    if (!channelReady("chat")) { toast.error("请先配置对话模型"); return false; }
    const linkage = useConfig.getState().config?.linkage;
    if (goalSettings(session.goal).enabled && (!linkage?.enabled || !linkage.useTools) && !codeRuntimeSettings(useConfig.getState().config?.codeRuntime).enabled) {
      toast.error("Goal 模式需要启用图像工具或内置 JS 编辑"); return false;
    }
    const cfg = useConfig.getState().config;
    if (cfg?.jury?.enabled && !juryMembers(cfg).length) {
      toast.error("请先添加并启用评审模型，或让 Chat 参与评审"); return false;
    }
    return true;
  };
  const startMessage = async (sessionId: string, text: string, attachments: ChatAttachment[], clearDraft: boolean) => {
    const userMsg: ChatMessage = { id: uid("m"), role: "user", content: text, attachments, createdAt: Date.now() };
    set((state) => ({ sessions: state.sessions.map((s) => s.id === sessionId ? {
      ...s, title: s.messages.length ? s.title : text.trim().slice(0, 24) || "图片对话",
      messages: [...s.messages, userMsg], ...(clearDraft ? { draftText: "", draftAtts: [] } : {}), updatedAt: Date.now(),
    } : s) }));
    void get().persist();
    await runTurn(sessionId, set, get);
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
    setImageModel: (imageModel) => {
      if (get().currentId && !get().runs[get().currentId!]) draft({ imageModel });
    },
    setGoal: (patch) => {
      const session = get().current();
      if (session && !get().runs[session.id]) draft({ goal: goalSettings({ ...goalSettings(session.goal), ...patch }) });
    },
    init: async () => {
      try {
        const raw = await api.loadState("sessions");
        if (raw) {
          const parsed = JSON.parse(raw) as { sessions: ChatSession[]; currentId: string | null };
          if (Array.isArray(parsed.sessions) && parsed.sessions.length) {
            // 重启后恢复待发送内容，但不擅自继续付费请求。
            const sessions = parsed.sessions.map((s) => ({ ...s, queuePaused: s.queuedMessages?.length ? true : s.queuePaused,
              messages: s.messages.map((message) => {
                const interrupted = message.juryReview?.status === "reviewing";
                const juryReview: JuryReview | undefined = interrupted ? { ...message.juryReview!, status: "stopped",
                  opinions: message.juryReview!.opinions.map((opinion) => opinion.status === "pending" ? { ...opinion, status: "stopped" } : opinion),
                } : message.juryReview;
                const codeInterrupted = message.codeExecution?.status === "running";
                return message.pending || interrupted || codeInterrupted ? { ...message, pending: false,
                  content: `${message.content || "应用重启，未完成的工具调用已停止。"}${interrupted ? "\n评审已因应用重启停止，请重新评审。" : ""}`,
                  ...(juryReview ? { juryReview } : {}),
                  ...(codeInterrupted ? { codeExecution: { ...message.codeExecution!, status: "stopped" as const, error: "应用重启，代码执行已停止" } } : {}),
                } : message;
              }),
            }));
            set({ sessions, currentId: sessions.some((s) => s.id === parsed.currentId) ? parsed.currentId : sessions[0].id });
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
    removeQueued: (id) => {
      draft({ queuedMessages: (get().current()?.queuedMessages ?? []).filter((message) => message.id !== id) });
      void get().persist();
    },
    clearQueue: () => { draft({ queuedMessages: [] }); void get().persist(); },
    pauseQueue: () => { draft({ queuePaused: true }); void get().persist(); },
    resumeQueue: async () => {
      const session = get().current();
      if (!session || !canSend(session)) return;
      draft({ queuePaused: false });
      void get().persist();
      await get().advanceQueue(session.id);
    },
    advanceQueue: async (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId);
      const next = session?.queuedMessages?.[0];
      if (!session || !next || session.queuePaused || get().runs[sessionId]) return;
      if (!canSend(session)) { draft({ queuePaused: true }, sessionId); void get().persist(); return; }
      draft({ queuedMessages: session.queuedMessages!.slice(1) }, sessionId);
      await startMessage(sessionId, next.text, next.attachments, false);
    },
    stop: (id) => {
      const sessionId = id ?? get().currentId;
      if (!sessionId) return;
      // 停止是停止整个自动发送流程；队列保留，等待用户继续。
      draft({ queuePaused: true }, sessionId);
      get().runs[sessionId]?.cancel?.();
      void get().persist();
    },
    send: async (text, attachments, mode = "send") => {
      const session = get().current();
      if (!session || (!text.trim() && !attachments.length)) return;
      const busy = Boolean(get().runs[session.id]);
      if (busy && mode === "send") return;
      if (!canSend(session)) return;
      const copied = attachments.map((attachment) => ({ ...attachment }));
      if (mode !== "send") {
        const next: QueuedMessage = { id: uid("queued"), text: text.trim(), attachments: copied, createdAt: Date.now(), mode };
        const queue = session.queuedMessages ?? [];
        draft({ queuedMessages: mode === "interrupt" ? [next, ...queue] : [...queue, next], queuePaused: mode === "interrupt" ? false : session.queuePaused ?? false, draftText: "", draftAtts: [] }, session.id);
        void get().persist();
        // 插话先结束旧轮（含未完成的工具响应），再优先发送，避免破坏工具调用顺序。
        if (mode === "interrupt" && busy) get().runs[session.id]?.cancel?.();
        if (!busy) await get().advanceQueue(session.id);
        return;
      }
      await startMessage(session.id, text.trim(), copied, true);
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
  const initialSession = get().sessions.find((session) => session.id === sessionId);
  const pinnedImageModel = initialSession?.imageModel ?? "";
  const goal = goalSettings(initialSession?.goal);
  const jury = jurySettings(cfg.jury);
  const codeRuntime = codeRuntimeSettings(cfg.codeRuntime);
  const original = [...(initialSession?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  const maxRounds = goal.enabled ? 6 + goal.maxCorrections * 3 : MAX_TOOL_ROUNDS;
  const maxImageCalls = goal.enabled ? 4 + goal.maxCorrections * 4 : 16;
  const progress: GoalProgress = { status: "working", level: goal.level, maxCorrections: goal.maxCorrections, corrections: 0, attempts: 0 };
  type PreparedImage = { request: ImageRequest; sourceLabels: string[]; sourceGalleryId?: string; stage: "asset" | "final"; retryOf?: string };
  const failedRequests = new Map<string, PreparedImage>();
  let lastFinalIds: string[] = [];
  let inCorrection = false;
  let terminal = false;
  let continuation = "";
  let stopped = false;
  let abort: (() => void) | null = null;
  const cancel = () => { stopped = true; abort?.(); };
  set((state) => ({ runs: { ...state.runs, [sessionId]: { runId, streaming: null, toolNote: "", cancel, ...(goal.enabled ? { goalProgress: { ...progress } } : {}) } } }));
  const active = () => !stopped && get().runs[sessionId]?.runId === runId && get().sessions.some((s) => s.id === sessionId);
  const patchRun = (patch: Partial<SessionRun>) => {
    if (get().runs[sessionId]?.runId !== runId) return;
    set((state) => ({ runs: { ...state.runs, [sessionId]: { ...state.runs[sessionId], ...patch } } }));
  };
  const readSession = () => get().sessions.find((s) => s.id === sessionId);
  const append = (msg: ChatMessage) => set((state) => ({ sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, messages: [...s.messages, msg], updatedAt: Date.now() } : s) }));
  const update = (id: string, patch: Partial<ChatMessage>) => set((state) => ({ sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, messages: s.messages.map((m) => m.id === id ? { ...m, ...patch } : m) } : s) }));
  const syncGoal = () => { if (goal.enabled) patchRun({ goalProgress: { ...progress } }); };
  const endGoal = (status: GoalProgress["status"], summary: string) => { progress.status = status; progress.summary = summary; terminal = true; syncGoal(); };
  const reviewImages = async (toolId: string, sources: ReturnType<typeof selectImageSources>, text: string,
    prompt = "", references: ReturnType<typeof selectImageSources> = [], focus = "") => {
    let report: JuryReview;
    try {
      patchRun({ toolNote: "正在读取评审图片…" });
      const images = await Promise.all(sources.map(async (source) => ({ ...source,
        dataUrl: source.dataUrl || (source.path ? await api.readImageDataUrl(source.path) : ""),
      })));
      if (!active()) throw new Error("已停止");
      patchRun({ toolNote: `评审团 · ${juryMembers(cfg).length} 位评审正在独立看图…` });
      const task = startJuryReview(cfg, {
        requirements: (readSession()?.messages ?? []).filter((message) => message.role === "user")
          .map((message, index) => `用户消息 ${index + 1}：${message.content}`).join("\n\n"),
        prompt, images, references, focus, goal: goal.enabled ? GOAL_LEVELS[goal.level].description : undefined,
      }, api.cancellableText, (juryReview) => {
        if (get().runs[sessionId]?.runId !== runId) return;
        update(toolId, { juryReview });
        void get().persist();
      });
      abort = task.cancel;
      if (stopped) task.cancel();
      report = await task.promise;
      abort = null;
    } catch (error) {
      abort = null;
      report = { imageIds: sources.map((source) => source.id), status: stopped ? "stopped" : "failed", createdAt: Date.now(),
        opinions: [{ memberId: "jury_input", name: "图片读取", model: "", status: stopped ? "stopped" : "error", error: jurySafeText(error, cfg) }],
      };
    }
    update(toolId, { pending: false, content: `${text}\n${juryFeedback(report)}`, juryReview: report });
    if (active()) patchRun({ toolNote: "评审完成，正在交给 Chat 汇总…" });
  };
  const background = api.startBackgroundTask();
  try {
    if (background) await background.ready;
    for (let round = 0; round <= maxRounds && active(); round += 1) {
      const session = readSession();
      if (!session) break;
      if (goal.enabled && !terminal && round === maxRounds) endGoal("limit", "已达到自动执行轮次上限，目标尚未完成验收。");
      const imageToolsEnabled = cfg.linkage.enabled && cfg.linkage.useTools;
      const useTools = (imageToolsEnabled || jury.enabled || codeRuntime.enabled) && round < maxRounds && !terminal;
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
            ...(cfg.linkage.enabled && cfg.linkage.useTools ? [{ role: "system", content: `${imageToolInstructions(session.messages)}\n\n${imageModelInstructions(cfg.image, pinnedImageModel)}` }] : []),
            ...(!imageToolsEnabled && (jury.enabled || codeRuntime.enabled) ? [{ role: "system", content: imageCatalogInstructions(session.messages) }] : []),
            ...(jury.enabled ? [{ role: "system", content: juryInstructions }] : []),
            ...(codeRuntime.enabled ? [{ role: "system", content: `${codeImageInstructions}\n本次代码超时上限：${codeRuntime.timeoutSecs} 秒。` }] : []),
            ...(goal.enabled ? [{ role: "system", content: `${goalInstructions(goal, progress.corrections)}${terminal ? `\n自动执行已结束：${progress.summary}。诚实总结已完成成果和未解决问题，不再调用工具。` : ""}` }] : []),
            ...history,
            ...(continuation ? [{ role: "user", content: continuation }] : []),
          ],
          temperature: cfg.chat.temperature, maxTokens: cfg.chat.maxTokens,
          tools: useTools ? [...(imageToolsEnabled ? imageTools(cfg.image, pinnedImageModel) : []), ...(goal.enabled ? [goalReviewTool] : []), ...(jury.enabled ? [juryReviewTool] : []), ...(codeRuntime.enabled ? [codeImageTool] : [])] : null, timeoutSecs: cfg.chat.timeoutSecs,
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
      if (!streamed) break;
      // 停止时保留已生成文字，丢弃未执行的工具调用。
      const assistant: ChatMessage = { id: messageId, role: "assistant", content: streamed.content.trim(), reasoning: streamed.reasoning.trim() || undefined,
        toolCalls: final.ok && useTools && streamed.toolCalls.length ? streamed.toolCalls : undefined,
        model: cfg.chat.model, createdAt: Date.now(), ...(final.ok ? {} : { error: final.error }) };
      // 以同一个 key 原子替换流式消息，避免消息短暂消失或折叠状态被重置。
      set((state) => ({
        sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, messages: [...s.messages, assistant], updatedAt: Date.now() } : s),
        runs: state.runs[sessionId]?.runId === runId ? { ...state.runs, [sessionId]: { ...state.runs[sessionId], streaming: null } } : state.runs,
      }));
      if (!final.ok || !active()) {
        if (goal.enabled && !terminal && !stopped) endGoal("error", final.error || "对话请求未完成");
        break;
      }
      if (!useTools) break;
      if (!streamed.toolCalls.length) {
        if (!goal.enabled || terminal) break;
        continuation = "Goal 仍在运行。请检查实际成果并调用 review_goal 逐项验收；不满足则自主修正，遇到不能解决的障碍则用 blocked 说明。不能只用文字声称已经满足。";
        continue;
      }
      continuation = "";
      const conv = readSession();
      if (!conv) break;
      for (const call of streamed.toolCalls) {
        const toolId = uid("m");
        append({ id: toolId, role: "tool", content: "", toolCallId: call.id, pending: true, createdAt: Date.now() });
        let prepared: PreparedImage | undefined;
        let codeExecution: CodeExecution | undefined;
        try {
          if (!active()) throw new Error("已停止");
          if (terminal) { update(toolId, { pending: false, content: "Goal 自动执行已经结束，此调用未执行。" }); continue; }
          const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
          if (call.name === "edit_image_code") {
            if (!codeRuntime.enabled) throw new Error("当前未启用代码图像编辑");
            if (typeof args.code !== "string" || !args.code.trim() || typeof args.description !== "string" || !args.description.trim()) throw new Error("代码编辑必须包含代码和处理说明");
            if (!Array.isArray(args.source_image_ids) || !args.source_image_ids.length || args.source_image_ids.length > 4) throw new Error("请选择 1–4 张实际输入图片 ID");
            if (args.stage !== undefined && args.stage !== "asset" && args.stage !== "final") throw new Error("代码图像阶段无效");
            const imageStage = args.stage === "asset" ? "asset" : "final";
            const sources = selectImageSources(readSession()?.messages ?? [], args.source_image_ids);
            const sourceLabels = sources.map((source) => source.label);
            codeExecution = { language: "javascript", code: args.code, description: args.description.trim(), sourceLabels, status: "running", logs: [] };
            update(toolId, { codeExecution });
            update(messageId, { toolCalls: readSession()?.messages.find((message) => message.id === messageId)?.toolCalls?.map((tc) => tc.id === call.id ? { ...tc, sourceLabels, imageStage } : tc) });
            if (progress.attempts >= maxImageCalls) { if (goal.enabled) endGoal("limit", "已达到图像调用保护上限。"); throw new Error("已达到本轮图像调用上限"); }
            if (goal.enabled && lastFinalIds.length && !inCorrection) {
              if (progress.corrections >= goal.maxCorrections) { endGoal("limit", "已达到修正上限，未执行代码修改。"); throw new Error("已达到 Goal 修正上限"); }
              progress.corrections += 1; inCorrection = true;
            }
            progress.attempts += 1; syncGoal();
            patchRun({ toolNote: "内置 JS · 正在处理图片…" });
            const inputs = await Promise.all(sources.map(async (source) => ({ ...source, dataUrl: source.dataUrl || (source.path ? await api.readImageDataUrl(source.path) : "") })));
            if (!active()) throw new Error("已停止");
            const task = startCodeEdit(inputs, args.code, codeRuntime);
            abort = task.cancel;
            if (stopped) task.cancel();
            const output = await task.promise;
            abort = null;
            if (!active()) throw new Error("已停止");
            const items = await api.saveImageOutputs(output.dataUrls, { kind: "edit", prompt: codeExecution.description, model: "builtin-js", size: "auto", parentId: sources[0]?.galleryId ?? null });
            if (!active()) throw new Error("已停止");
            if (!items.length) throw new Error("代码没有返回实际图片");
            codeExecution = { ...codeExecution, status: "complete", logs: output.logs.map((log) => jurySafeText(log, cfg)), elapsedMs: output.elapsedMs, outputSizes: output.sizes };
            update(toolId, { pending: false, content: `代码已处理 ${items.length} 张图片：${codeExecution.description}`, codeExecution,
              images: items.map((item) => ({ galleryId: item.id, path: item.path, dataUrl: item.dataUrl ?? undefined, prompt: item.prompt, size: item.size, model: item.model,
                kind: item.kind, createdAt: item.createdAt, parentId: item.parentId, revisedPrompt: item.revisedPrompt })),
            });
            if (imageStage === "final") { lastFinalIds = items.map((item) => `image_${item.id}`); inCorrection = false; }
            if (jury.enabled && imageStage === "final") {
              update(toolId, { pending: true });
              await reviewImages(toolId, items.map((item, index) => ({ id: `image_${item.id}`, label: `代码结果 ${index + 1}（图片 ID：image_${item.id}）`, path: item.path, dataUrl: item.dataUrl ?? undefined })),
                `代码已处理 ${items.length} 张图片：${codeExecution.description}`, codeExecution.description, inputs);
            }
            continue;
          }
          if (call.name === "review_images") {
            if (!jury.enabled) throw new Error("当前未启用评审团");
            if (!Array.isArray(args.source_image_ids) || !args.source_image_ids.length) throw new Error("请选择实际图片 ID");
            const sources = selectImageSources(readSession()?.messages ?? [], args.source_image_ids);
            if (sources.length > 4) throw new Error("一次最多评审 4 张图片");
            await reviewImages(toolId, sources, `评审 ${sources.length} 张已有图片。`, "", [], typeof args.focus === "string" ? args.focus : "");
            continue;
          }
          if (call.name === "review_goal") {
            if (!goal.enabled) throw new Error("当前会话未开启 Goal 模式");
            const review = parseGoalReview(args);
            if (review.status === "satisfied" && progress.attempts > 0 && !lastFinalIds.length) throw new Error("本 Goal 已请求图像，但尚未返回实际最终图片，不能宣称图像任务已满足");
            if (review.imageIds.length) selectImageSources(readSession()?.messages ?? [], review.imageIds);
            if (lastFinalIds.some((id) => !review.imageIds.includes(id))) throw new Error("Goal 检查必须包含本次最新的全部最终图片，不能以旧图代替");
            progress.checks = review.checks; progress.summary = review.summary;
            update(toolId, { pending: false, content: `Goal 检查：${review.status}\n${review.summary}\n${JSON.stringify(review.checks)}${review.answer ? `\n最终答案：${review.answer}` : ""}`, goalReview: review });
            if (review.status === "satisfied") endGoal("satisfied", review.summary);
            else if (review.status === "blocked") endGoal("blocked", review.summary);
            else if (progress.corrections >= goal.maxCorrections) endGoal("limit", `已达到 ${goal.maxCorrections} 次修正上限，仍有未通过项：${review.summary}`);
            else if (!review.imageIds.length) { progress.corrections += 1; syncGoal(); }
            else syncGoal();
            continue;
          }
          if (call.name === "retry_image") {
            if (typeof args.failed_call_id !== "string") throw new Error("必须指定实际失败的调用 ID");
            const previous = failedRequests.get(args.failed_call_id);
            if (!previous) throw new Error("该调用不是当前轮可重试的失败请求");
            const imageModel = selectImageModel(cfg.image, args.model ?? previous.request.model, pinnedImageModel);
            if (previous.request.images?.length && !canEditImageModel(imageModel)) throw new Error(`生图模型 ${imageModel.id} 已设为仅文生图，不能重试参考图编辑请求`);
            prepared = { ...previous, request: { ...previous.request, ...imageModelConnection(cfg.image, imageModel) }, retryOf: args.failed_call_id };
          } else {
            if (call.name !== "generate_image" && call.name !== "edit_image") throw new Error(`未知工具：${call.name}`);
            const prompt = String(args.prompt ?? "").trim();
            if (!prompt) throw new Error("模型没有给出图像指令");
            const imageModel = selectImageModel(cfg.image, args.model, pinnedImageModel);
            const connection = imageModelConnection(cfg.image, imageModel);
            const sources = call.name === "edit_image" ? selectImageSources(conv.messages, args.source_image_ids) :
              args.source_image_ids !== undefined ? selectImageSources(conv.messages, args.source_image_ids) : [];
            if ((call.name === "edit_image" || sources.length) && !canEditImageModel(imageModel)) throw new Error(`生图模型 ${imageModel.id} 已设为仅文生图，请选择支持参考图/合成的模型`);
            if (call.name === "edit_image" && !sources.length) throw new Error("没有选择可用的参考图片");
            const images = await Promise.all(sources.map((image) => image.dataUrl || (image.path ? api.readImageDataUrl(image.path) : Promise.reject(new Error("参考图片无法读取")))));
            if (!active()) throw new Error("已停止");
            const sourceLabels = sources.map((source) => source.label);
            const stage = args.stage === "asset" ? "asset" : "final";
            const sentPrompt = `${prompt}\n\n${stage === "asset" ? "整体任务背景（本次仅生成上面指令指定的中间素材，不执行其他模型的步骤或提前合成；保留与本素材有关的文字、数量、对应关系与禁止项）：" : "用户原始要求（必须保留文字、数量、构图、素材对应关系与禁止项）："}\n${original}`;
            prepared = { request: { ...connection, prompt: sentPrompt, images, imageLabels: sourceLabels,
              n: Math.min(Math.max(Math.floor(Number(args.n ?? 1)) || 1, 1), 4), size: imageToolSize(args.size, cfg.image.size),
              quality: cfg.image.quality, background: cfg.image.background, outputFormat: cfg.image.outputFormat }, sourceLabels, sourceGalleryId: sources[0]?.galleryId, stage };
          }
          const { request: imageRequest, sourceLabels, stage: imageStage } = prepared;
          if (!imageRequest.baseUrl || !imageRequest.apiKey) throw new Error(`请先配置生图模型 ${imageRequest.model} 的服务地址和 API Key`);
          update(messageId, { toolCalls: readSession()?.messages.find((m) => m.id === messageId)?.toolCalls?.map((tc) => tc.id === call.id ? { ...tc, sourceLabels, sentPrompt: imageRequest.prompt, imageModel: imageRequest.model, imageApiMode: imageRequest.apiMode as ToolCall["imageApiMode"], imageStage, retryOf: prepared?.retryOf, requestedSize: imageRequest.size ?? "auto" } : tc) });
          if (progress.attempts >= maxImageCalls) { if (goal.enabled) endGoal("limit", "已达到图像调用保护上限，停止自动执行。"); throw new Error("已达到本轮图像调用上限"); }
          if (goal.enabled && lastFinalIds.length && !inCorrection) {
            if (progress.corrections >= goal.maxCorrections) { endGoal("limit", "已达到修正上限，未执行新的图像请求。"); throw new Error("已达到 Goal 修正上限"); }
            progress.corrections += 1; inCorrection = true;
          }
          progress.attempts += 1; syncGoal();
          patchRun({ toolNote: `${imageRequest.model} · ${prepared.retryOf ? "正在重试图像请求…" : imageRequest.images?.length ? `正在使用 ${imageRequest.images.length} 张素材编辑图像…` : "正在生成图片…"}` });
          const request = api.cancellableImage(imageRequest, prepared.sourceGalleryId);
          abort = request.cancel;
          if (stopped) abort();
          const items = await request.promise;
          abort = null;
          if (!active()) throw new Error("已停止");
          if (!items.length) throw new Error("服务没有返回图片");
          if (imageStage === "final") { lastFinalIds = items.map((item) => `image_${item.id}`); inCorrection = false; }
          update(toolId, { pending: false, content: `已生成 ${items.length} 张${imageStage === "asset" ? "中间素材，请继续剩余生成/合成步骤" : "图片"}。`, images: items.map((item) => ({
            galleryId: item.id, path: item.path, dataUrl: item.dataUrl ?? undefined, prompt: item.prompt, size: item.size, model: item.model,
            kind: item.kind, createdAt: item.createdAt, parentId: item.parentId, revisedPrompt: item.revisedPrompt,
          })) });
          if (jury.enabled && imageStage === "final") {
            update(toolId, { pending: true });
            await reviewImages(toolId, items.map((item, index) => ({ id: `image_${item.id}`, label: `结果图 ${index + 1}（图片 ID：image_${item.id}）`, path: item.path, dataUrl: item.dataUrl ?? undefined })),
              `已生成 ${items.length} 张图片。`, imageRequest.prompt,
              (imageRequest.images ?? []).map((dataUrl, index) => ({ id: `reference_${index}`, label: sourceLabels[index] ?? `素材 ${index + 1}`, dataUrl })));
          }
        } catch (err) {
          abort = null;
          const error = stopped ? "已停止" : jurySafeText(imageFailureMessage(err, cfg.image), cfg);
          if (prepared && !stopped && !terminal) failedRequests.set(call.id, prepared);
          if (codeExecution) update(toolId, { codeExecution: { ...codeExecution, status: stopped ? "stopped" : "error", error } });
          update(toolId, { pending: false, content: `执行失败：${error}${!stopped && !terminal && call.name !== "review_goal" && call.name !== "review_images" && call.name !== "edit_image_code" ? `\n${JSON.stringify({ failed_call_id: call.id, model: prepared?.request.model, retry_available: !!prepared, enabled_models: configuredImageModels(cfg.image).map((model) => model.id), decision: "由 Chat 分析错误，决定使用 retry_image 重试同一模型、选择其他启用模型，或说明无法继续；不能丢失原始要求和素材。" })}` : ""}` });
          if (!stopped) toast.error(error);
        }
      }
      if (terminal) continuation = `自动执行已结束：${progress.summary}。请简洁总结实际成果和未解决问题，不再调用工具。`;
      void get().persist();
    }
  } catch (err) {
    if (!stopped) toast.error((err as Error).message);
    if (goal.enabled && !terminal && !stopped) endGoal("error", imageFailureMessage(err, cfg.image));
  } finally {
    await background?.finish();
    if (goal.enabled && readSession()) {
      if (stopped && !terminal) { progress.status = "stopped"; progress.summary = "用户已停止 Goal 自动执行。"; }
      else if (!terminal) { progress.status = "limit"; progress.summary = "自动执行已停止，目标尚未完成验收。"; }
      append({ id: uid("m"), role: "assistant", content: `Goal ${progress.status}：${progress.summary ?? ""}`, goalProgress: { ...progress }, createdAt: Date.now() });
    }
    if (get().runs[sessionId]?.runId === runId) {
      set((state) => { const runs = { ...state.runs }; delete runs[sessionId]; return { runs }; });
    }
    void get().persist();
    void get().advanceQueue(sessionId);
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
