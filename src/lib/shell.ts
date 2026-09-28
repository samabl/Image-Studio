import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

/** 用系统浏览器打开外链；失败时退回 window.open。 */
export async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** 用系统默认程序打开本地文件。 */
export async function openLocalPath(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch (err) {
    throw new Error(`无法打开文件：${(err as Error).message ?? err}`);
  }
}

/** 在文件管理器中定位文件。 */
export async function revealPath(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch {
    await openLocalPath(path).catch(() => undefined);
  }
}

/** 复制纯文本到剪贴板。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 老 WebView 退回到 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}
