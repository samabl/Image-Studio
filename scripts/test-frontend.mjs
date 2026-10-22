import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = async (path, imports = {}) => {
  let code = ts.transpileModule(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const [specifier, replacement] of Object.entries(imports)) code = code.replaceAll(`"${specifier}"`, JSON.stringify(replacement));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
};
const chatUrl = await compile("src/lib/chat.ts");
const chat = await import(chatUrl);
const attachment = (id) => ({ id, dataUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`, name: `${id}.png` });
const message = (role, extra = {}) => ({ id: `${role}_${Math.random()}`, role, content: "", createdAt: 1, ...extra });

test("多素材按展示顺序发送，文字标签与每张图片相邻", () => {
  const [m] = chat.toApiMessages(message("user", { content: "保留素材 1 的人物，使用素材 2 的背景", attachments: [attachment("a"), attachment("b")] }));
  assert.equal(m.content[1].text, "素材 1：a.png（图片 ID：a）");
  assert.equal(m.content[2].image_url.url, attachment("a").dataUrl);
  assert.equal(m.content[3].text, "素材 2：b.png（图片 ID：b）");
  assert.equal(m.content[4].image_url.url, attachment("b").dataUrl);
});

test("编辑默认使用最近一组全部素材，显式 ID 支持跨消息选择与重排", () => {
  const messages = [message("user", { attachments: [attachment("old")] }), message("user", { attachments: [attachment("a"), attachment("b")] })];
  assert.deepEqual(chat.selectImageSources(messages).map((a) => a.id), ["a", "b"]);
  assert.deepEqual(chat.selectImageSources(messages, ["b", "old", "a"]).map((a) => a.id), ["b", "old", "a"]);
  assert.throws(() => chat.selectImageSources(messages, ["missing"]));
  assert.throws(() => chat.selectImageSources(messages, ["a", "a"]));
});

test("多个工具响应连续发送，所有视觉反馈放在工具响应后", () => {
  const messages = [message("assistant", { toolCalls: [{ id: "c1", name: "edit_image", arguments: "{}" }, { id: "c2", name: "edit_image", arguments: "{}" }] }),
    ...[1, 2].map((i) => message("tool", { toolCallId: `c${i}`, content: "完成", images: [{ galleryId: `g${i}`, path: "x", dataUrl: attachment(`g${i}`).dataUrl, prompt: "" }] }))];
  const out = chat.conversationMessages(messages);
  assert.deepEqual(out.map((m) => m.role), ["assistant", "tool", "tool", "user", "user"]);
  assert.equal(out[3].content[2].image_url.url, attachment("g1").dataUrl);
});

test("Gemini 工具调用保留原始 thoughtSignature 供下一轮回传", () => {
  const providerData = { functionCall: { name: "edit_image", args: { prompt: "编辑" } }, thoughtSignature: "signature" };
  const [m] = chat.toApiMessages(message("assistant", { toolCalls: [{ id: "c", name: "edit_image", arguments: '{"prompt":"编辑"}', providerData }] }));
  assert.deepEqual(m.tool_calls[0].provider_data, providerData);
});

let harnessId = 0;
async function harness() {
  const streams = [];
  const imageCalls = [];
  const textCalls = [];
  const saves = [];
  const api = {
    loadState: async () => null,
    saveState: async (_key, value) => { saves.push(JSON.parse(value)); },
    chatStream: (request, onEvent) => {
      const stream = { request, onEvent, canceled: false };
      streams.push(stream);
      return { streamId: `${streams.length}`, cancel: () => { stream.canceled = true; } };
    },
    cancellableImage: (request, parentId) => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const call = { request, parentId, resolve, reject, canceled: false };
      imageCalls.push(call);
      return { promise, cancel: () => { call.canceled = true; reject(new Error("已停止")); } };
    },
    readImageDataUrl: async () => attachment("disk").dataUrl,
    cancellableText: (request) => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const task = { request, resolve, reject, canceled: false }; textCalls.push(task);
      return { promise, cancel: () => { task.canceled = true; reject(new Error("已停止")); } };
    },
    chatOnce: async (request) => { api.onceRequest = request; return "优化后的提示词"; },
  };
  globalThis.__studioTestApi = api;
  const apiUrl = `data:text/javascript,${encodeURIComponent(Object.keys(api).map((name) => `export const ${name} = (...args) => globalThis.__studioTestApi.${name}(...args);`).join("\n"))}`;
  const imageUrl = await compile("src/lib/image.ts");
  const storeUrl = await compile("src/lib/store.ts", { zustand: import.meta.resolve("zustand"), "./api": apiUrl, "./image": imageUrl, "./chat": chatUrl });
  const store = await import(`${storeUrl}#${++harnessId}`);
  store.useConfig.setState({ ready: true, config: {
    chat: { protocol: "openai", baseUrl: "https://example.test", apiKey: "test-key", model: "test-model", systemPrompt: "测试", maxTokens: 4096, temperature: null, timeoutSecs: 30, stream: true, models: [] },
    image: { baseUrl: "https://example.test", apiKey: "test-key", model: "image-test", apiMode: "images", timeoutSecs: 30, size: "auto", n: 1, quality: "auto", background: "auto", outputFormat: "auto", models: [] },
    linkage: { enabled: true, useTools: true, autoOptimizePrompt: false, visionModel: "", optimizeSystemPrompt: "优化", reverseSystemPrompt: "反推" }, ui: { sendOnEnter: true },
  } });
  await store.useSessions.getState().init();
  return { ...store, streams, imageCalls, textCalls, saves, api };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const complete = (stream, text = "完成") => { stream.onEvent({ type: "delta", text }); stream.onEvent({ type: "done", finishReason: "stop" }); };

test("两个会话并发时输出、停止和草稿互不影响，同会话禁止重复提交", async () => {
  const h = await harness();
  const sessions = h.useSessions.getState;
  const first = sessions().currentId;
  const p1 = sessions().send("第一会话", []);
  await sessions().send("重复发送", []);
  assert.equal(h.streams.length, 1);
  h.streams[0].onEvent({ type: "delta", text: "第一会话部分回复" });
  sessions().newSession();
  const second = sessions().currentId;
  sessions().setDraftText("第二会话草稿");
  sessions().addDraftAtts([attachment("second")]);
  const p2 = sessions().send("第二会话", []);
  assert.equal(Object.keys(sessions().runs).length, 2);
  sessions().selectSession(first);
  sessions().setDraftText("第一会话草稿");
  sessions().stop();
  await p1;
  assert.equal(h.streams[0].canceled, true);
  assert.equal(h.streams[1].canceled, false);
  h.streams[0].onEvent({ type: "delta", text: "过期输出" });
  assert.ok(sessions().runs[second]);
  complete(h.streams[1], "第二会话回复");
  await p2;
  assert.equal(sessions().runs[first], undefined);
  assert.equal(sessions().runs[second], undefined);
  const one = sessions().sessions.find((s) => s.id === first);
  const two = sessions().sessions.find((s) => s.id === second);
  assert.equal(one.draftText, "第一会话草稿");
  assert.equal(one.messages[1].content, "第一会话部分回复");
  assert.equal(two.messages[1].content, "第二会话回复");
  await sessions().persist();
});

test("草稿素材跨会话隔离，可重排并保持延迟导入的目标会话", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  const first = sessions().currentId;
  sessions().setDraftText("first"); sessions().addDraftAtts([attachment("a"), attachment("b")]);
  sessions().moveDraftAtt("b", -1);
  sessions().newSession(); const second = sessions().currentId;
  sessions().setDraftText("second"); sessions().addDraftAtts([attachment("late")], first);
  assert.deepEqual(sessions().current().draftAtts, []);
  sessions().selectSession(first);
  assert.deepEqual(sessions().current().draftAtts.map((a) => a.id), ["b", "a", "late"]);
  assert.equal(sessions().current().draftText, "first");
  sessions().deleteSession(second); assert.equal(sessions().currentId, first);
  await sessions().persist();
});

test("对话编辑完整传递多图、指定顺序、原始指令，并反馈实际图片", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  const pending = sessions().send("素材 1 的两个人站在素材 2 的背景里，文字保持中文", [attachment("a"), attachment("b")]);
  h.streams[0].onEvent({ type: "toolCalls", calls: [{ id: "call", name: "edit_image", arguments: JSON.stringify({ prompt: "合成", source_image_ids: ["b", "a"] }) }] });
  h.streams[0].onEvent({ type: "done", finishReason: "tool_calls" });
  await tick();
  const call = h.imageCalls[0];
  assert.deepEqual(call.request.images, [attachment("b").dataUrl, attachment("a").dataUrl]);
  assert.ok(call.request.prompt.includes("两个人"));
  assert.equal(call.request.imageLabels[0], "素材 2：b.png（图片 ID：b）");
  call.resolve([{ id: "g", path: "g.png", dataUrl: attachment("g").dataUrl, prompt: "合成", model: "image-test", size: "auto" }]);
  await tick();
  const roles = h.streams[1].request.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-3), ["assistant", "tool", "user"]);
  assert.ok(JSON.stringify(h.streams[1].request.messages).includes(attachment("g").dataUrl));
  complete(h.streams[1]); await pending;
  assert.equal(h.useGallery.getState().items.length, 1);
});

test("停止图像工具中断其请求，不触发后续对话循环", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  const pending = sessions().send("出图", []);
  h.streams[0].onEvent({ type: "toolCalls", calls: [{ id: "c", name: "generate_image", arguments: '{"prompt":"猫"}' }] });
  h.streams[0].onEvent({ type: "done", finishReason: "tool_calls" }); await tick();
  sessions().stop(); await pending;
  assert.equal(h.imageCalls[0].canceled, true);
  assert.equal(h.streams.length, 1);
  assert.equal(sessions().current().messages.at(-1).pending, false);
});

test("优化提示词读取全部参考图，并要求保留原始约束", async () => {
  const h = await harness();
  await h.optimizePromptText("两个人，素材 1 的人物，素材 2 的背景", [attachment("a"), attachment("b")]);
  const req = h.api.onceRequest;
  assert.equal(req.messages[1].content.filter((p) => p.type === "image_url").length, 2);
  assert.ok(req.messages[0].content.includes("禁止项"));
  assert.equal(req.protocol, "openai");
});

test("修改第一张编辑素材会清除旧蒙版；其他素材重排保留蒙版", async () => {
  const h = await harness(); const studio = h.useStudio.getState;
  studio().setRefs([attachment("a"), attachment("b"), attachment("c")]);
  studio().setMaskEnabled(true); studio().setStrokes([{ size: 1, points: [] }]);
  studio().moveRef("c", -1); assert.equal(studio().strokes.length, 1);
  studio().moveRef("c", -1); assert.equal(studio().strokes.length, 0); assert.equal(studio().maskEnabled, false);
});

test("模型列表不按已选 GPT 名称筛选，显示所有提供方", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const url = await compile("src/components/ModelPicker.tsx", { react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime") });
  const { ModelPicker } = await import(url);
  const markup = renderToStaticMarkup(createElement(ModelPicker, { value: "gpt-test", models: ["gpt-test", "claude-test", "gemini-test", "deepseek-test"], onChange() {}, onBlur() {} }));
  for (const model of ["claude-test", "gemini-test", "deepseek-test"]) assert.ok(markup.includes(model));
});

test("保存图像支持原图、历史文件与 Android URI；取消不会写文件", async () => {
  globalThis.__saveTest = { options: [], writes: [], reads: [], target: "content://documents/image.png" };
  const state = globalThis.__saveTest;
  const dialog = `data:text/javascript,${encodeURIComponent("export async function save(options) { globalThis.__saveTest.options.push(options); return globalThis.__saveTest.target; }")}`;
  const fs = `data:text/javascript,${encodeURIComponent("export async function writeFile(path, bytes) { globalThis.__saveTest.writes.push({path, bytes}); }")}`;
  const api = `data:text/javascript,${encodeURIComponent("export async function readImageDataUrl(path) { globalThis.__saveTest.reads.push(path); return 'data:image/jpeg;base64,YQ=='; }")}`;
  const image = await compile("src/lib/image.ts");
  const url = await compile("src/lib/save.ts", { "@tauri-apps/plugin-dialog": dialog, "@tauri-apps/plugin-fs": fs, "./api": api, "./image": image });
  const { saveImage } = await import(url);
  assert.equal(await saveImage({ dataUrl: "data:image/png;base64,YQ==" }), state.target);
  assert.equal(state.writes[0].path, "content://documents/image.png");
  assert.deepEqual([...state.writes[0].bytes], [97]);
  await saveImage({ path: "history.jpg" });
  assert.deepEqual(state.reads, ["history.jpg"]);
  assert.deepEqual(state.options[1].filters[0].extensions, ["jpg"]);
  state.target = null;
  assert.equal(await saveImage({ dataUrl: "data:image/png;base64,YQ==" }), null);
  assert.equal(state.writes.length, 2);
});

test("停止自动优化会中断文字请求并阻止后续出图", async () => {
  const h = await harness();
  const cfg = h.useConfig.getState().config;
  h.useConfig.setState({ config: { ...cfg, linkage: { ...cfg.linkage, autoOptimizePrompt: true } } });
  h.useStudio.getState().setPrompt("保留素材人物");
  const pending = h.useStudio.getState().run();
  assert.equal(h.textCalls.length, 1);
  h.useStudio.getState().stop(); await pending;
  assert.equal(h.textCalls[0].canceled, true);
  assert.equal(h.imageCalls.length, 0);
  assert.equal(h.useStudio.getState().busy, false);
});

test("自动优化使用所有素材，并把原始要求保留在出图请求里", async () => {
  const h = await harness(); const cfg = h.useConfig.getState().config;
  h.useConfig.setState({ config: { ...cfg, linkage: { ...cfg.linkage, autoOptimizePrompt: true } } });
  h.useStudio.getState().setRefs([attachment("a"), attachment("b")]);
  h.useStudio.getState().setPrompt("恰好两个人，保留文字你好");
  const pending = h.useStudio.getState().run();
  assert.equal(h.textCalls[0].request.messages[1].content.filter((p) => p.type === "image_url").length, 2);
  h.textCalls[0].resolve("优化文本"); await tick();
  assert.ok(h.imageCalls[0].request.prompt.includes("恰好两个人，保留文字你好"));
  assert.deepEqual(h.imageCalls[0].request.images, [attachment("a").dataUrl, attachment("b").dataUrl]);
  h.imageCalls[0].resolve([{ id: "g", path: "g.png", prompt: "", model: "", size: "" }]); await pending;
});
