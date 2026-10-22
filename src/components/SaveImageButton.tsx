import { useState } from "react";
import { saveImage, type SaveableImage } from "../lib/save";
import { toast } from "../lib/store";
import { isAndroid } from "../lib/platform";

export function SaveImageButton({ image }: { image: SaveableImage }) {
  const [saving, setSaving] = useState(false);
  const save = (destination: "default" | "file") => {
    setSaving(true);
    void saveImage(image, destination).then((target) => { if (target) toast.success(isAndroid && destination === "default" ? "已保存到相册 · Pictures/Image Studio" : "图像已保存"); })
      .catch((err: Error) => toast.error(err.message)).finally(() => setSaving(false));
  };
  return <>
    <button type="button" className="btn sm ghost" disabled={saving} onClick={() => save("default")}>{saving ? "保存中…" : isAndroid ? "⤓ 保存到相册" : "⤓ 保存图像"}</button>
    {isAndroid && <button type="button" className="btn sm ghost" disabled={saving} onClick={() => save("file")}>另存为…</button>}
  </>;
}
