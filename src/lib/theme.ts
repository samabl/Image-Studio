import type { ThemeMode } from "../types";

export const THEME_LABELS: Record<ThemeMode, string> = { system: "跟随系统", light: "明亮", dark: "深色" };
const CACHE_KEY = "image-studio-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function normalizeTheme(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

export function cachedTheme(): ThemeMode {
  try { return normalizeTheme(localStorage.getItem(CACHE_KEY)); }
  catch { return "system"; }
}

export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "system" ? "light" : mode === "light" ? "dark" : "system";
}

/** 本机缓存只用于启动时提前绘制，配置文件仍是主题设置的来源。 */
export function applyTheme(mode: ThemeMode, systemDark = window.matchMedia(DARK_QUERY).matches): "light" | "dark" {
  const resolved = mode === "system" ? systemDark ? "dark" : "light" : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const color = resolved === "light" ? "#f6faf8" : "#0a0c13";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  return resolved;
}

export function watchTheme(mode: ThemeMode, onChange?: (theme: "light" | "dark") => void): () => void {
  try { localStorage.setItem(CACHE_KEY, mode); } catch { /* 缓存不可用时仍由 config.json 保存。 */ }
  const media = window.matchMedia(DARK_QUERY);
  const sync = () => { const resolved = applyTheme(mode, media.matches); onChange?.(resolved); };
  sync();
  if (mode !== "system") return () => {};
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }
  media.addListener(sync);
  return () => media.removeListener(sync);
}
