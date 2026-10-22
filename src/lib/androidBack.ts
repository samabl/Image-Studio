interface BackActions {
  closePreview: () => boolean;
  closePanel: () => boolean;
  returnHome: () => boolean;
  notify: () => void;
  persist: () => void;
}

/** 返回键只在首页连续两次操作时将任务移到后台，其他操作逐层关闭。 */
export function createBackHandler(actions: BackActions, now = Date.now) {
  let armedAt: number | null = null;
  return (): "handled" | "exit" => {
    if (actions.closePreview() || actions.closePanel() || actions.returnHome()) { armedAt = null; return "handled"; }
    const time = now();
    if (armedAt !== null && time - armedAt <= 2000) { armedAt = null; actions.persist(); return "exit"; }
    armedAt = time; actions.notify(); return "handled";
  };
}
