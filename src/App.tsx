import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChatView } from "./components/ChatView";
import { StudioView } from "./components/StudioView";
import { GalleryView } from "./components/GalleryView";
import { SettingsView } from "./components/SettingsView";
import { Lightbox, Toasts, useLightbox } from "./components/Overlays";
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
import { importImageFile, setNativeTheme } from "./lib/api";
import { fileToAttachment } from "./lib/image";
import { isAndroid, isIOS, isMobile, supportsFileDrop } from "./lib/platform";
import { createBackHandler } from "./lib/androidBack";
import { cachedTheme, nextTheme, normalizeTheme, THEME_LABELS, watchTheme } from "./lib/theme";

const NAV: { key: TabKey; icon: string; label: string; title: string }[] = [
  { key: "chat", icon: "💬", label: "对话", title: "AI 对话" },
  { key: "studio", icon: "🎨", label: "生成", title: "图像工作室" },
  { key: "gallery", icon: "🖼", label: "图库", title: "图库" },
  { key: "settings", icon: "⚙️", label: "设置", title: "设置" },
];

export default function App() {
  const ready = useConfig((s) => s.ready);
  const tab = useConfig((s) => s.tab);
  const cfg = useConfig((s) => s.config);
  const [bootError, setBootError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("image-studio-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const theme = cfg ? normalizeTheme(cfg.ui.theme) : cachedTheme();
  const next = nextTheme(theme);

  useEffect(() => watchTheme(theme, (resolved) => {
    if (isAndroid) void setNativeTheme(resolved, theme).catch(() => undefined);
  }), [theme]);

  useEffect(() => {
    bootstrap().catch((err) => setBootError((err as Error).message));
  }, []);

  useEffect(() => {
    try { localStorage.setItem("image-studio-sidebar-collapsed", String(sidebarCollapsed)); } catch { /* 私密模式下仍可折叠。 */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isMobile) return;
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty("--app-height", `${viewport?.height ?? window.innerHeight}px`);
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); document.documentElement.style.removeProperty("--app-height"); };
  }, []);

  useEffect(() => {
    if (!isAndroid) return;
    const target = window as Window & { __imageStudioBack?: () => string };
    target.__imageStudioBack = createBackHandler({
      closePreview: () => { if (!useLightbox.getState().image) return false; useLightbox.getState().hide(); return true; },
      closePanel: () => {
        if (!window.dispatchEvent(new Event("image-studio-back", { cancelable: true }))) return true;
        const opened = Array.from(document.querySelectorAll<HTMLDetailsElement>("details[open]"))
          .filter((element) => element.getClientRects().length);
        const last = opened[opened.length - 1];
        if (last) { last.open = false; return true; }
        return false;
      },
      returnHome: () => { if (useConfig.getState().tab === "chat") return false; useConfig.getState().setTab("chat"); return true; },
      notify: () => useToast.getState().push("info", "再按一次返回键回到桌面，运行中的任务会继续"),
      persist: () => { void useSessions.getState().persist(); void useConfig.getState().flush(); },
    });
    return () => { delete target.__imageStudioBack; };
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
          const targetTab = useConfig.getState().tab;
          const targetSession = useSessions.getState().currentId;
          void (async () => {
            try {
              const atts = await Promise.all(
                images.map(async (p, i) => {
                  const dataUrl = await importImageFile(p);
                  return {
                    id: `drop_${Date.now()}_${i}`,
                    dataUrl,
                    name: p.split(/[\\/]/).pop(),
                  };
                }),
              );
              // 按当前页面决定落点：对话页进输入框附件，其余进图像工作室参考图
              const current = targetTab;
              if (current === "chat") {
                useSessions.getState().addDraftAtts(atts, targetSession ?? undefined);
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
      const targetTab = useConfig.getState().tab;
      const targetSession = useSessions.getState().currentId;
      void (async () => {
        const atts = [];
        for (const f of files) atts.push(await fileToAttachment(f));
        if (targetTab === "chat") {
          useSessions.getState().addDraftAtts(atts, targetSession ?? undefined);
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
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`} data-platform={isAndroid ? "android" : isIOS ? "ios" : "desktop"} data-mobile={isMobile}>
      <nav id="main-navigation" className="sidebar" aria-label="主导航">
        <div className="brand">
          <img className="brand-mark" src="/app-icon.png" alt="Image Studio" />
          <div className="brand-text">
            <strong>Image Studio</strong>
          </div>
        </div>

        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`nav-item${tab === n.key ? " active" : ""}`}
            aria-label={n.label}
            aria-current={tab === n.key ? "page" : undefined}
            title={n.label}
            onClick={() => useConfig.getState().setTab(n.key)}
          >
            <span className="ico">{n.icon}</span>
            <span className="nav-label">{n.label}</span>
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
        </div>
      </nav>

      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          <button type="button" className="btn icon ghost sidebar-toggle" aria-label={sidebarCollapsed ? "展开导航" : "收起导航"} aria-expanded={!sidebarCollapsed} aria-controls="main-navigation" onClick={() => setSidebarCollapsed((value) => !value)}>☰</button>
          <div>
            <h1>{active.title}</h1>
          </div>
          <div className="topbar-right">
            <button type="button" className="btn sm ghost theme-toggle"
              aria-label={`主题：${THEME_LABELS[theme]}，切换为${THEME_LABELS[next]}`}
              title={`当前：${THEME_LABELS[theme]}；点击切换为${THEME_LABELS[next]}`}
              onClick={() => { useConfig.getState().patchUi({ theme: next }); void useConfig.getState().flush(); }}>
              <span aria-hidden="true">{theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}</span>
              <span className="theme-toggle-label">{THEME_LABELS[theme]}</span>
            </button>
            {tab === "gallery" && (
              <button
                type="button"
                className="btn sm ghost"
                aria-label="刷新图库"
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
