import { useRef, useState } from "react";
import { version } from "../../package.json";
import { checkForUpdates } from "../lib/api";
import { isAndroid } from "../lib/platform";
import { openExternal } from "../lib/shell";
import { LATEST_RELEASE_URL, trustedUpdateUrl } from "../lib/updates";
import type { SoftwareUpdate as UpdateInfo } from "../types";
import { Panel } from "./ui";

export function SoftwareUpdate() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const checking = useRef(false);
  const check = async () => {
    if (checking.current) return;
    checking.current = true; setLoading(true); setError("");
    try { setInfo(await checkForUpdates()); }
    catch (err) { setError((err as Error).message); }
    finally { checking.current = false; setLoading(false); }
  };
  const open = (url: string) => {
    if (!trustedUpdateUrl(url)) { setError("更新链接不是本仓库的 Release 地址"); return; }
    void openExternal(url).catch((err: Error) => setError(err.message));
  };
  return <Panel title={`软件更新 · v${version}`} className="settings-panel" defaultOpen>
    <div className="settings-stack">
      <div className="row wrap">
        <span className="chip">当前版本：v{info?.currentVersion ?? version}</span>
        {info && <span className={`chip${info.available ? " success" : ""}`}>{info.available ? `发现新版本：v${info.latestVersion}` : `已是最新或更新版本（Release v${info.latestVersion}）`}</span>}
      </div>
      <div className="row wrap">
        <button className="btn" type="button" disabled={loading} onClick={() => void check()}>{loading ? "检查中…" : "检查更新"}</button>
        <button className="btn" type="button" onClick={() => open(LATEST_RELEASE_URL)}>打开最新 Release</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {info && <>
        <div className="hint">{info.releaseName}{info.publishedAt && ` · ${new Date(info.publishedAt).toLocaleDateString()}`} · {info.platform}</div>
        <div className="row wrap">
          {info.downloads.map((asset) => <button key={asset.name} className={`btn${info.available && asset.recommended ? " primary" : ""}`} type="button" onClick={() => open(asset.url)}>
            {asset.recommended ? "下载推荐安装包" : "下载便携版"}{asset.size > 0 && ` (${(asset.size / 1048576).toFixed(1)} MB)`}
          </button>)}
        </div>
        {!info.downloads.length && <p className="hint">此 Release 没有当前系统架构的安装包，请在 Release 页面查看可用下载。</p>}
        {info.notes && <details className="update-notes"><summary>更新说明</summary><pre>{info.notes}</pre></details>}
      </>}
      <p className="hint">通过系统浏览器下载，由系统安装器确认更新；不会自动替换应用或清除配置。{isAndroid && " Android 覆盖安装需新旧 APK 使用相同签名，不要先卸载旧版。"}</p>
    </div>
  </Panel>;
}
