/** 运行平台判定。移动端与桌面端在文件保存、拖拽等能力上有差异。 */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isAndroid = /Android/i.test(ua);
export const isIOS = /iPhone|iPad|iPod/i.test(ua);
export const isMobile = isAndroid || isIOS;
/** Windows / macOS / Linux 桌面端 */
export const isDesktop = !isMobile;

/** 该环境是否支持 Tauri 的拖拽事件（仅桌面 WebView 支持） */
export const supportsFileDrop = isDesktop;

/** 是否支持把图片写入系统剪贴板 */
export const supportsClipboardImage =
  typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
