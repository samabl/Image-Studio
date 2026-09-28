import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChatView } from "./components/ChatView";
import { StudioView } from "./components/StudioView";
import { GalleryView } from "./components/GalleryView";
import { SettingsView } from "./components/SettingsView";
import { Lightbox, Toasts } from "./components/Overlays";
import { Spinner } from "./components/ui";
import {
  bootstrap,
  useConfig,
  useGallery,
  useSessions,
  useStudio,
  useToast,
  channelReady,
  type TabKey,
} from "./lib/store";
import { importImageFile } from "./lib/api";
import { fileToAttachment } from "./lib/image";
import { supportsFileDrop } from "./lib/platform";

const NAV: { key: TabKey; icon: string; label: string; title: string; sub: string }[] = [
  { key: "chat", icon: "💬", label: "对话", title: "AI 对话", sub: "多轮聊天 · 看图 · 驱动图像模型" },
  { key: "studio", icon: "🎨", label: "生成", title: "图像工作室", sub: "文生图 · 图生图 · 局部重绘" },
  { key: "gallery", icon: "🖼", label: "图库", title: "图库", sub: "所有产出的原图与历史" },
  { key: "settings", icon: "⚙️", label: "设置", title: "设置", sub: "模型配置 · 联动 · 数据" },
];

export default function App() {
  const ready = useConfig((s) => s.ready);
  const tab = useConfig((s) => s.tab);
  const dir = useConfig((s) => s.dir);
  const cfg = useConfig((s) => s.config);
  const [bootError, setBootError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    bootstrap().catch((err) => setBootError((err as Error).message));
  }, []);

  // 桌面端：把图片文件拖进窗口直接导入到当前页面
  useEffect(() => {
    if (!supportsFileDrop) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over") {
          setDropping(true);
        } else if (payload.type === "leave") {
          setDropping(false);
        } else if (payload.type === "drop") {
          setDropping(false);
          const paths = payload.paths ?? [];
          const images = paths.filter((p) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p));
          if (images.length === 0) return;
          void (async () => {
            try {
              const atts = await Promise.all(
                images.slice(0, 8).map(async (p, i) => {
                  const dataUrl = await importImageFile(p);
                  return {
                    id: `drop_${Date.now()}_${i}`,
                    dataUrl,
                    name: p.split(/[\\/]/).pop(),
                  };
                }),
              );
              // 按当前页面决定落点：对话页进输入框附件，其余进图像工作室参考图
              const current = useConfig.getState().tab;
              if (current === "chat") {
                useSessions.getState().addDraftAtts(atts);
                useToast
                  .getState()
                  .push("success", `已添加 ${atts.length} 张图片，发消息时会一起送给模型`);
              } else {
                useStudio.getState().addRefs(atts);
                useConfig.getState().setTab("studio");
                useToast.getState().push("success", `已导入 ${atts.length} 张参考图`);
              }
            } catch (err) {
              useToast.getState().push("error", (err as Error).message);
            }
          })();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  // 浏览器式粘贴图片（Ctrl+V）进入工作室
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!files.length) return;
      void (async () => {
        const atts = [];
        for (const f of files.slice(0, 4)) atts.push(await fileToAttachment(f));
        if (useConfig.getState().tab === "chat") {
          useSessions.getState().addDraftAtts(atts);
          useToast.getState().push("success", "已从剪贴板添加图片到对话");
        } else {
          useStudio.getState().addRefs(atts);
          useConfig.getState().setTab("studio");
          useToast.getState().push("success", "已从剪贴板导入参考图");
        }
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const active = NAV.find((n) => n.key === tab) ?? NAV[0];

  if (bootError) {
    return (
      <div className="empty" style={{ height: "100vh" }}>
        <div className="big">⚠️</div>
        <div style={{ color: "var(--text-dim)" }}>应用启动失败</div>
        <div className="err" style={{ maxWidth: 560 }}>
          {bootError}
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="empty" style={{ height: "100vh" }}>
        <Spinner size={22} />
        <div>正在启动…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark">🎨</div>
          <div className="brand-text">
            <strong>GPT Image Studio</strong>
            <span>对话 · 文生图 · 图生图 · 编辑</span>
          </div>
        </div>

        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`nav-item${tab === n.key ? " active" : ""}`}
            onClick={() => useConfig.getState().setTab(n.key)}
          >
            <span className="ico">{n.icon}</span>
            <span>{n.label}</span>
          </button>
        ))}

        <div className="nav-spacer" />

        <div className="nav-foot">
          <div style={{ marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className={`chip${channelReady("chat") ? " accent" : ""}`}>
              对话 {channelReady("chat") ? "就绪" : "未配置"}
            </span>
            <span className={`chip${channelReady("image") ? " accent" : ""}`}>
              图像 {channelReady("image") ? "就绪" : "未配置"}
            </span>
          </div>
          {cfg?.image.model && <div>图像模型：{cfg.image.model}</div>}
          {dir && <div title={dir}>数据目录：{dir}</div>}
        </div>
      </nav>

      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          <div>
            <h1>{active.title}</h1>
          </div>
          <div className="sub">{active.sub}</div>
          <div className="topbar-right">
            {tab === "gallery" && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => void useGallery.getState().refresh()}
              >
                ↻
              </button>
            )}
          </div>
        </header>

        <div className="view">
          {tab === "chat" && <ChatView />}
          {tab === "studio" && <StudioView />}
          {tab === "gallery" && <GalleryView />}
          {tab === "settings" && <SettingsView />}
        </div>
      </main>

      <Lightbox />
      <Toasts />
      {dropping && <div className="drop-veil">松开鼠标导入图片</div>}
    </div>
  );
}
