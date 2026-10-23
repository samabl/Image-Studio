"use strict";
// 此页面必须以 sandbox="allow-scripts" 加载：没有同源身份或应用权限。
// 引导脚本加载后再收紧脚本策略；Blob Worker 继承它，不能动态导入脚本或 eval。
// 不用 SRI：opaque origin 下它需要 CORS，会阻止部分原生 WebView 的本地资源。
const workerPolicy = document.createElement("meta");
workerPolicy.httpEquiv = "Content-Security-Policy";
workerPolicy.content = "default-src 'none'; script-src 'none'; worker-src blob:; connect-src 'none'; object-src 'none'";
document.head.appendChild(workerPolicy);
let worker = null;
let taskId = null;
let workerUrl = null;
function stop() {
  if (worker) worker.terminate();
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  worker = null;
  workerUrl = null;
}
window.addEventListener("message", (event) => {
  if (event.source !== parent || !event.data || typeof event.data.id !== "string") return;
  if (event.data.type === "cancel" && event.data.id === taskId) { stop(); return; }
  if (event.data.type !== "execute" || taskId !== null || typeof event.data.source !== "string") return;
  taskId = event.data.id;
  try {
    workerUrl = URL.createObjectURL(new Blob([event.data.source], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
    worker.onmessage = ({ data }) => {
      if (!data || data.id !== taskId) return;
      const transfer = data.type === "result" && Array.isArray(data.images)
        ? data.images.map((image) => image.data.buffer) : [];
      parent.postMessage(data, "*", transfer);
      stop();
    };
    worker.onerror = (error) => {
      parent.postMessage({ type: "error", id: taskId, message: error.message || "代码执行失败" }, "*");
      stop();
    };
    worker.postMessage({ id: taskId, images: event.data.images }, event.data.images.map((image) => image.data.buffer));
  } catch (error) {
    parent.postMessage({ type: "error", id: taskId, message: error instanceof Error ? error.message : String(error) }, "*");
    stop();
  }
});
window.addEventListener("pagehide", stop);
parent.postMessage({ type: "ready" }, "*");
