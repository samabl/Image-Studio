import { useState } from "react";
import { saveImage, type SaveableImage } from "../lib/save";
import { toast } from "../lib/store";

export function SaveImageButton({ image }: { image: SaveableImage }) {
  const [saving, setSaving] = useState(false);
  return <button type="button" className="btn sm ghost" disabled={saving} onClick={() => {
    setSaving(true);
    void saveImage(image).then((target) => { if (target) toast.success("图像已保存"); })
      .catch((err: Error) => toast.error(err.message)).finally(() => setSaving(false));
  }}>{saving ? "保存中…" : "⤓ 保存图像"}</button>;
}
