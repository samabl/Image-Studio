import { useMemo, useState } from "react";
import { Empty, Seg } from "./ui";
import { GalleryThumb, showImage } from "./Overlays";
import { useConfig, useGallery, useSessions, useStudio, useToast, reversePromptText } from "../lib/store";
import { readImageDataUrl } from "../lib/api";
import type { GalleryItem, GalleryKind } from "../types";

type Filter = "all" | GalleryKind;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "generate", label: "文生图" },
  { value: "edit", label: "图生图" },
  { value: "mask", label: "局部重绘" },
  { value: "chat", label: "对话产出" },
];

export function GalleryView() {
  const { items, loading, selected, refresh, remove, clear, toggleSelect, clearSelection } =
    useGallery();
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const note = useToast((s) => s.push);

  const shown = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  );

  const withDataUrl = async (item: GalleryItem) =>
    item.dataUrl ?? (await readImageDataUrl(item.path));

  return (
    <div className="view">
      <div className="topbar" style={{ height: "auto", padding: "10px 16px", flexWrap: "wrap" }}>
        <Seg value={filter} onChange={setFilter} options={FILTERS} />
        <span className="chip">{shown.length} 张</span>
        <div className="topbar-right">
          <button type="button" className="btn sm" onClick={() => void refresh()}>
            {loading ? "刷新中…" : "↻ 刷新"}
          </button>
          {selected.length > 0 && (
            <>
              <span className="chip accent">已选 {selected.length}</span>
              <button
                type="button"
                className="btn sm danger"
                onClick={() => {
                  void remove(selected).then(() => note("success", "已删除所选图片"));
                }}
              >
                删除所选
              </button>
              <button type="button" className="btn sm ghost" onClick={clearSelection}>
                取消选择
              </button>
            </>
          )}
          {items.length > 0 && selected.length === 0 && (
            <button
              type="button"
              className={`btn sm ${confirmClear ? "danger" : "ghost"}`}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  setTimeout(() => setConfirmClear(false), 4000);
                  return;
                }
                setConfirmClear(false);
                void clear().then(() => note("success", "图库已清空"));
              }}
            >
              {confirmClear ? "确认清空？" : "清空图库"}
            </button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty
          icon="🖼"
          title={items.length === 0 ? "图库还是空的" : "该分类下没有图片"}
          hint="生成或编辑的图片会自动归档到这里，文件保存在应用数据目录中。"
        />
      ) : (
        <div className="scroll">
          <div className="gallery-grid">
            {shown.map((item) => (
              <div
                key={item.id}
                className={`gal-card${selected.includes(item.id) ? " selected" : ""}`}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || selected.length > 0) {
                    toggleSelect(item.id);
                  } else {
                    showImage({ item, path: item.path, dataUrl: item.dataUrl });
                  }
                }}
              >
                <GalleryThumb item={item} />
                <div className="gal-check">{selected.includes(item.id) ? "✓" : ""}</div>
                <div className="gal-info">
                  <div className="p" title={item.prompt}>
                    {item.prompt || "（无提示词）"}
                  </div>
                  <span className="chip">{item.size}</span>
                  {item.parentId && <span className="chip accent">派生</span>}
                </div>
                <div className="gal-info" style={{ paddingTop: 0, gap: 4 }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      void withDataUrl(item).then((u) =>
                        useStudio
                          .getState()
                          .sendToStudio({ dataUrl: u, galleryId: item.id, prompt: item.prompt }, "edit"),
                      );
                    }}
                  >
                    ✎ 编辑
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      void (async () => {
                        try {
                          const u = await withDataUrl(item);
                          note("info", "正在反推提示词…");
                          const p = await reversePromptText(u);
                          useStudio.setState({ prompt: p });
                          useToast.getState().push("success", "已反推提示词并填入图像工作室");
                        } catch (err) {
                          note("error", (err as Error).message);
                        }
                      })();
                    }}
                    title="用对话模型看图并反推提示词"
                  >
                    🔍 反推
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      void (async () => {
                        try {
                          const u = await withDataUrl(item);
                          useSessions.getState().newSession();
                          useConfig.getState().setTab("chat");
                          // 直接把图片投喂给对话模型，并提示它可以继续编辑
                          await useSessions
                            .getState()
                            .send(
                              "这是我要处理的图片，请先看看它，然后告诉我可以怎么改；如果需要动手就调用 edit_image。",
                              [{ id: `gal_${item.id}`, dataUrl: u, galleryId: item.id }],
                            );
                        } catch (err) {
                          note("error", (err as Error).message);
                        }
                      })();
                    }}
                    title="把图片带进对话，让对话模型直接改"
                  >
                    💬 去对话
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
