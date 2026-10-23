export const LATEST_RELEASE_URL = "https://github.com/samabl/Image-Studio/releases/latest";

/** UI 仅打开本仓库 Release/安装包链接，不执行下载文件。 */
export function trustedUpdateUrl(value: string): boolean {
  try {
    if (/[\\?#\u0000-\u001f\u007f]|%2f|%5c/i.test(value)) return false;
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === "/samabl/Image-Studio/releases/latest" ||
       (/^\/samabl\/Image-Studio\/releases\/tag\/[^/]+$/.test(url.pathname) ||
        /^\/samabl\/Image-Studio\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname)));
  } catch { return false; }
}
