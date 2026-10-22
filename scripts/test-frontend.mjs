import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
const imageModelsUrl = await compile("src/lib/imageModels.ts");
const imageModels = await import(imageModelsUrl);
const imageSizeUrl = await compile("src/lib/imageSize.ts");
const goalUrl = await compile("src/lib/goal.ts");
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
  const backgroundTasks = [];
  const backgroundState = { enabled: false };
  const api = {
    startBackgroundTask: () => {
      if (!backgroundState.enabled) return null;
      const task = { finished: false, ready: Promise.resolve(), finish: async () => { task.finished = true; } };
      backgroundTasks.push(task);
      return task;
    },
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
  const storeUrl = await compile("src/lib/store.ts", { zustand: import.meta.resolve("zustand"), "./api": apiUrl, "./image": imageUrl, "./chat": chatUrl, "./imageModels": imageModelsUrl, "./imageSize": imageSizeUrl, "./goal": goalUrl });
  const store = await import(`${storeUrl}#${++harnessId}`);
  store.useConfig.setState({ ready: true, config: {
    chat: { protocol: "openai", baseUrl: "https://example.test", apiKey: "test-key", model: "test-model", systemPrompt: "测试", maxTokens: 4096, temperature: null, timeoutSecs: 30, stream: true, models: [] },
    image: { baseUrl: "https://example.test", apiKey: "test-key", model: "image-test", apiMode: "images", timeoutSecs: 30, size: "auto", n: 1, quality: "auto", background: "auto", outputFormat: "auto", models: [] },
    linkage: { enabled: true, useTools: true, autoOptimizePrompt: false, visionModel: "", optimizeSystemPrompt: "优化", reverseSystemPrompt: "反推" }, ui: { sendOnEnter: true },
  } });
  await store.useSessions.getState().init();
  return { ...store, streams, imageCalls, textCalls, saves, api, backgroundTasks, backgroundState };
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

test("Android 后台任务跨越生图和回图检查，并隔离并发会话及取消", async () => {
  const h = await harness(); h.backgroundState.enabled = true;
  const sessions = h.useSessions.getState;
  const first = sessions().currentId;
  const p1 = sessions().send("生成苹果", []); await tick();
  assert.equal(h.backgroundTasks.length, 1);
  h.streams[0].onEvent({ type: "toolCalls", calls: [{ id: "generate", name: "generate_image", arguments: '{"prompt":"红苹果"}' }] });
  complete(h.streams[0], "正在**生成图片**"); await tick();
  assert.equal(h.backgroundTasks[0].finished, false);
  sessions().newSession();
  const second = sessions().currentId;
  const p2 = sessions().send("第二个后台任务", []); await tick();
  assert.equal(h.backgroundTasks.length, 2);
  sessions().stop(second); await p2;
  assert.equal(h.backgroundTasks[1].finished, true);
  assert.equal(h.backgroundTasks[0].finished, false);
  h.imageCalls[0].resolve([{ id: "g", path: "g.png", dataUrl: attachment("g").dataUrl, prompt: "红苹果", model: "image", size: "1024x1024" }]);
  await tick();
  assert.equal(h.backgroundTasks[0].finished, false);
  assert.equal(h.backgroundTasks.length, 2, "检查阶段复用同一个后台任务，避免重新从后台启动服务");
  complete(h.streams[2], "**检查完成**：图片正确。"); await p1;
  assert.equal(h.backgroundTasks[0].finished, true);
  assert.equal(sessions().sessions.find((s) => s.id === first).messages.at(-1).content, "**检查完成**：图片正确。");
});

test("Android 工作室取消和启动服务失败时清理任务，避免继续出图", async () => {
  const h = await harness(); h.backgroundState.enabled = true;
  h.useStudio.getState().setPrompt("画一个苹果");
  const pending = h.useStudio.getState().run(); await tick();
  h.useStudio.getState().stop(); await pending;
  assert.equal(h.backgroundTasks[0].finished, true);
  assert.equal(h.useStudio.getState().busy, false);
  h.api.startBackgroundTask = () => ({ ready: Promise.reject(new Error("服务启动被拒绝")), finish: async () => {} });
  const calls = h.imageCalls.length;
  await h.useSessions.getState().send("生图", []);
  assert.equal(h.streams.length, 0);
  assert.equal(h.imageCalls.length, calls);
  assert.deepEqual(h.useSessions.getState().runs, {});
});

test("完整 AI 指令和文字跨生图、回图检查及下一轮保存，流式消息原子落盘", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  const pending = sessions().send("只改手臂，其他保持", [attachment("original")]);
  const prompt = "保留原画风，修正手臂和袖口。\n" + "原图面部、发饰、场景、衣服和床铺细节保持不变。".repeat(12) + "这是完整指令的结尾。";
  const explanation = "**修正方案**：只调整手臂和袖口。";
  const transient = [];
  const unsubscribe = h.useSessions.subscribe((state) => {
    if (!state.runs[state.currentId]?.streaming && !state.sessions.find((s) => s.id === state.currentId)?.messages.some((m) => m.content === explanation)) transient.push(state);
  });
  h.streams[0].onEvent({ type: "delta", text: explanation });
  h.streams[0].onEvent({ type: "toolCalls", calls: [{ id: "edit", name: "edit_image", arguments: JSON.stringify({ prompt, source_image_ids: ["original"] }) }] });
  h.streams[0].onEvent({ type: "done", finishReason: "tool_calls" });
  await tick(); unsubscribe();
  assert.equal(transient.length, 0, "完成流式消息与移除临时消息必须一次更新");
  const before = sessions().current().messages.find((m) => m.role === "assistant");
  assert.equal(before.content, explanation);
  assert.equal(JSON.parse(before.toolCalls[0].arguments).prompt, prompt);
  assert.equal(before.toolCalls[0].sentPrompt, h.imageCalls[0].request.prompt);
  assert.equal(before.toolCalls[0].sourceLabels[0], "素材 1：original.png（图片 ID：original）");
  assert.equal(sessions().runs[sessions().currentId].toolNote, "image-test · 正在使用 1 张素材编辑图像…");
  h.imageCalls[0].resolve([{ id: "g", path: "g.png", dataUrl: attachment("g").dataUrl, prompt, model: "image", size: "1024x1024" }]);
  await tick(); complete(h.streams[1], "**检查完成**：手臂已修正。"); await pending;
  const after = sessions().current().messages.find((m) => m.id === before.id);
  assert.deepEqual(after, before);
  await sessions().persist();
  assert.deepEqual(h.saves.at(-1).sessions[0].messages.find((m) => m.id === before.id), JSON.parse(JSON.stringify(before)));
  const next = sessions().send("继续修袖口", []);
  complete(h.streams[2], "保留上次修正，下一步修袖口。"); await next;
  assert.deepEqual(sessions().current().messages.find((m) => m.id === before.id), before);
});

test("旧历史与新消息中的完整 AI 指令可展示、复制，不依赖临时进度", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const shell = `data:text/javascript,${encodeURIComponent("export async function copyText() {};")}`;
  const store = `data:text/javascript,${encodeURIComponent("export const useToast = { getState: () => ({push(){}}) };")}`;
  const url = await compile("src/components/ImageToolDetails.tsx", { "../lib/shell": shell, "../lib/store": store, "../lib/imageModels": imageModelsUrl, "react/jsx-runtime": import.meta.resolve("react/jsx-runtime") });
  const { ImageToolDetails } = await import(url);
  const prompt = "修正手臂。\n" + "不要改变构图和场景。".repeat(50) + "完整提示词结尾";
  const call = {id:"edit", name:"edit_image", arguments:JSON.stringify({prompt,source_image_ids:["result","original"]})};
  const old = renderToStaticMarkup(createElement(ImageToolDetails,{call}));
  assert.ok(old.includes(prompt));
  assert.ok(old.includes("完整提示词结尾"));
  assert.ok(old.includes("result → original"));
  assert.ok(old.includes("复制完整指令"));
  const current = renderToStaticMarkup(createElement(ImageToolDetails,{call,labels:["结果图 1","原始素材 1"],sentPrompt:prompt+"\n原始要求：只改手臂"}));
  assert.ok(current.includes("结果图 1 → 原始素材 1"));
  assert.ok(current.includes("原始要求：只改手臂"));
  assert.ok(renderToStaticMarkup(createElement(ImageToolDetails,{call:{...call,arguments:"{invalid"}})).includes("{invalid"));
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

test("生图说明和回图检查中的粗体、斜体及流式片段能完成渲染", async () => {
  const shell = `data:text/javascript,${encodeURIComponent("export async function copyText() {}; export async function openExternal() {};")}`;
  const url = await compile("src/components/Markdown.tsx", {
    react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"), "../lib/shell": shell,
  });
  // 在子进程验证，回归死循环时超时失败，避免耗尽测试进程/CI 的内存。
  const script = `
    import assert from "node:assert/strict";
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    const { Markdown } = await import(${JSON.stringify(url)});
    const render = (source) => renderToStaticMarkup(React.createElement(Markdown, { source }));
    assert.equal(render("正在**生成图像**，随后*检查结果*。"), '<div class="md"><p>正在<strong>生成图像</strong>，随后<em>检查结果</em>。</p></div>');
    assert.equal(render("**检查 _两张素材_ 的顺序**"), '<div class="md"><p><strong>检查 <em>两张素材</em> 的顺序</strong></p></div>');
    assert.equal(render("__保留文字__ 和 _构图_，**数量**正确"), '<div class="md"><p><strong>保留文字</strong> 和 <em>构图</em>，<strong>数量</strong>正确</p></div>');
    const response = "## **图像检查**\\n- **文字**：正确\\n- *构图*：符合要求\\n\\n| 项目 | 结果 |\\n| --- | --- |\\n| **素材顺序** | __正确__ |\\n\\n> **完成**，不再重复生图。";
    const html = render(response);
    assert.ok(html.includes('<h2><strong>图像检查</strong></h2>'));
    assert.ok(html.includes('<td><strong>素材顺序</strong></td>'));
    assert.ok(html.includes('<blockquote><strong>完成</strong>，不再重复生图。</blockquote>'));
    for (let i = 1; i <= response.length; i += 1) render(response.slice(0, i));
    assert.ok(render('**文字 <script>alert(1)</script>**').includes('&lt;script&gt;'));
  `;
  const child = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-"], {
    input: script, encoding: "utf8", timeout: 5000, maxBuffer: 16384,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || `Renderer exited with ${child.signal}`);
});

test("保存图像支持原图、历史文件与 Android URI；取消不会写文件", async () => {
  globalThis.__saveTest = { options: [], writes: [], reads: [], target: "content://documents/image.png" };
  const state = globalThis.__saveTest;
  const dialog = `data:text/javascript,${encodeURIComponent("export async function save(options) { globalThis.__saveTest.options.push(options); return globalThis.__saveTest.target; }")}`;
  const fs = `data:text/javascript,${encodeURIComponent("export async function writeFile(path, bytes) { globalThis.__saveTest.writes.push({path, bytes}); }")}`;
  const api = `data:text/javascript,${encodeURIComponent("export async function readImageDataUrl(path) { globalThis.__saveTest.reads.push(path); return 'data:image/jpeg;base64,YQ=='; }; export async function saveImageToAlbum() { throw new Error('unexpected album save'); }")}`;
  const image = await compile("src/lib/image.ts");
  const platform = `data:text/javascript,${encodeURIComponent("export const isAndroid=false;")}`;
  const url = await compile("src/lib/save.ts", { "@tauri-apps/plugin-dialog": dialog, "@tauri-apps/plugin-fs": fs, "./api": api, "./image": image, "./platform": platform });
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

test("模型 ID 自适应接口与手动覆盖遵循同一套路由样例", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/image-routing.json", import.meta.url), "utf8"));
  for (const { model, baseUrl, mode, expected } of fixtures) assert.equal(imageModels.resolveImageApiMode(mode, model, baseUrl), expected, `${model} ${baseUrl} ${mode}`);
  assert.throws(() => imageModels.resolveImageApiMode("unsupported", "alias", "https://example.test"), /不支持/);
});

test("模型池兼容旧配置，独立连接不继承其他服务的密钥", async () => {
  const h = await harness(); const cfg = h.useConfig.getState().config.image;
  assert.deepEqual(imageModels.configuredImageModels(cfg), [{ id: "image-test", apiMode: "images" }]);
  const custom = { id: "gemini-image", apiMode: "auto", baseUrl: "https://native.example.test/v1beta" };
  assert.equal(imageModels.imageModelConnection(cfg, custom).apiKey, "");
  assert.equal(imageModels.imageModelConnection(cfg, { ...custom, baseUrl: "https://example.test/v1" }).apiKey, "test-key");
  assert.equal(imageModels.imageModelConnection(cfg, { ...custom, apiKey: "native-test-key" }).apiKey, "native-test-key");
  const pool = { ...cfg, modelPool: [{ id: " model-A ", apiMode: "auto" }, { id: "model-A", apiMode: "chat" }] };
  assert.deepEqual(imageModels.configuredImageModels(pool).map((entry) => entry.id), ["model-A"]);
  assert.equal(imageModels.selectImageModel(pool).id, "model-A");
});

test("图像模型选择复用同连接的完整列表，并隔离不同密钥、服务与协议", async () => {
  const h = await harness(); const { image, chat } = h.useConfig.getState().config;
  const config = { ...image, models: ["image-A"], modelPool: [{ id: "image-A", apiMode: "auto" }, { id: "custom-C", apiMode: "chat" }] };
  const shared = { ...chat, baseUrl: `${image.baseUrl}/v1/chat/completions`, models: ["image-A", "gemini-B", "flux-D"] };
  assert.deepEqual(imageModels.availableImageModelIds(config, shared), ["image-A", "gemini-B", "flux-D", "custom-C"]);
  for (const patch of [{ apiKey: "another-key" }, { baseUrl: "https://another.example.test" }, { protocol: "anthropic" }]) {
    assert.deepEqual(imageModels.availableImageModelIds(config, { ...shared, ...patch }), ["image-A", "custom-C"]);
  }
  assert.deepEqual(imageModels.availableImageModelIds({ ...config, apiMode: "gemini" }, { ...shared, protocol: "gemini" }), ["image-A", "gemini-B", "flux-D", "custom-C"]);
});

test("图像工具枚举限制启用模型，合成只提供可编辑模型", async () => {
  const h = await harness(); const cfg = h.useConfig.getState().config.image;
  const pool = { ...cfg, modelPool: [{ id: "A", apiMode: "auto", supportsEditing: false }, { id: "C", apiMode: "chat", supportsEditing: true }] };
  const tools = h.imageTools(pool);
  assert.deepEqual(tools[0].function.parameters.properties.model.enum, ["A", "C"]);
  assert.deepEqual(tools[1].function.parameters.properties.model.enum, ["C"]);
  assert.ok(tools[0].function.parameters.required.includes("model"));
  assert.deepEqual(h.imageTools(pool, "A").map((tool) => tool.function.name), ["generate_image", "retry_image"]);
  assert.deepEqual(h.imageTools(pool, "C")[0].function.parameters.properties.model.enum, ["C"]);
  assert.throws(() => imageModels.selectImageModel(pool, "not-enabled"), /未启用/);
  assert.throws(() => imageModels.selectImageModel(pool, "C", "A"), /指定/);
});

const generated = (id, model) => ({ id, path: `${id}.png`, dataUrl: attachment(id).dataUrl, prompt: `来自 ${model}`, model, size: "auto" });
const callTool = (stream, calls) => {
  const toolCalls = calls.map((call, i) => ({ id: `call-${i}-${Math.random()}`, name: call.name ?? "generate_image", arguments: JSON.stringify(call.args) }));
  stream.onEvent({ type: "toolCalls", calls: toolCalls });
  stream.onEvent({ type: "done", finishReason: "tool_calls" });
  return toolCalls;
};

const goalCheck = (status, imageIds, passed = status === "satisfied") => ({ status, summary: passed ? "逐项符合要求" : "需要修正人物数量", image_ids: imageIds, checks: [{ requirement: "恰好两个人", passed, details: passed ? "实际图片包含两个人" : "实际图片只有一个人" }] });

test("Goal 自动检查实际回图、修正后重新验收，达标才结束并保存记录", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  sessions().setGoal({ enabled: true, level: "strict", maxCorrections: 2 });
  const pending = sessions().send("恰好两个人，文字保持你好", []);
  assert.ok(h.streams[0].request.tools.some((tool) => tool.function.name === "review_goal"));
  assert.ok(h.streams[0].request.messages.some((message) => typeof message.content === "string" && message.content.includes("验收等级：严格")));
  sessions().setGoal({ level: "relaxed" }); assert.equal(sessions().current().goal.level, "strict");
  callTool(h.streams[0], [{ args: { prompt: "两个人" } }]); await tick();
  h.imageCalls[0].resolve([generated("initial", "image-test")]); await tick();
  assert.ok(JSON.stringify(h.streams[1].request.messages).includes(attachment("initial").dataUrl));
  callTool(h.streams[1], [{ name: "review_goal", args: goalCheck("needs_revision", ["image_initial"]) }]); await tick();
  callTool(h.streams[2], [{ name: "edit_image", args: { prompt: "补齐第二个人，保留文字", source_image_ids: ["image_initial"] } }]); await tick();
  assert.deepEqual(h.imageCalls[1].request.images, [attachment("initial").dataUrl]);
  assert.ok(h.imageCalls[1].request.prompt.includes("文字保持你好"));
  h.imageCalls[1].resolve([generated("fixed", "image-test")]); await tick();
  callTool(h.streams[3], [{ name: "review_goal", args: goalCheck("satisfied", ["image_initial"]) }]); await tick();
  assert.ok(sessions().current().messages.at(-1).content.includes("不能以旧图代替"));
  callTool(h.streams[4], [{ name: "review_goal", args: goalCheck("satisfied", ["image_fixed"]) }]); await tick();
  assert.equal(h.streams[5].request.tools, null);
  complete(h.streams[5], "已修正并满足要求"); await pending;
  const report = sessions().current().messages.at(-1).goalProgress;
  assert.equal(report.status, "satisfied"); assert.equal(report.corrections, 1); assert.equal(report.attempts, 2);
  await sessions().persist(); assert.equal(h.saves.at(-1).sessions[0].messages.at(-1).goalProgress.status, "satisfied");
  assert.equal(h.imageCalls.length, 2);
});

test("Goal 不能用文字宣称完成、旧图或未通过检查代替最新实际回图", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  sessions().setGoal({ enabled: true, maxCorrections: 1 });
  const pending = sessions().send("生成两个人", []);
  complete(h.streams[0], "已经完成"); await tick();
  assert.equal(h.streams.length, 2); assert.ok(h.streams[1].request.messages.at(-1).content.includes("不能只用文字"));
  callTool(h.streams[1], [{ args: { prompt: "两个人" } }]); await tick();
  h.imageCalls[0].resolve([generated("current", "image-test")]); await tick();
  callTool(h.streams[2], [{ name: "review_goal", args: goalCheck("satisfied", ["image_missing"]) }]); await tick();
  assert.ok(sessions().current().messages.at(-1).content.includes("找不到图片"));
  callTool(h.streams[3], [{ name: "review_goal", args: goalCheck("satisfied", ["image_current"], false) }]); await tick();
  assert.ok(sessions().current().messages.at(-1).content.includes("不能判定"));
  callTool(h.streams[4], [{ name: "review_goal", args: goalCheck("blocked", ["image_current"]) }]); await tick();
  complete(h.streams[5], "当前模型无法满足"); await pending;
  assert.equal(sessions().current().messages.at(-1).goalProgress.status, "blocked");
});

test("文字 Goal 通过完整答案验收，图像请求失败不能用空回图宣称完成", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  sessions().setGoal({enabled:true,maxCorrections:1});
  const text=sessions().send("写一个标题",[]);
  callTool(h.streams[0],[{name:"review_goal",args:{status:"satisfied",summary:"标题符合要求",answer:"清新图像工作台",checks:[{requirement:"简短中文标题",passed:true,details:"使用七字中文标题"}]}}]); await tick();
  complete(h.streams[1]); await text;
  assert.equal(sessions().current().messages.at(-1).goalProgress.status,"satisfied");
  assert.ok(sessions().current().messages.some(m=>m.goalReview?.answer==="清新图像工作台"));
  const image=sessions().send("生成图片",[]);
  callTool(h.streams[2],[{args:{prompt:"生成图片"}}]); await tick(); h.imageCalls[0].reject(new Error("服务不可用")); await tick();
  callTool(h.streams[3],[{name:"review_goal",args:{...goalCheck("satisfied",[]),answer:"已生成"}}]); await tick();
  assert.ok(sessions().current().messages.at(-1).content.includes("尚未返回实际最终图片"));
  callTool(h.streams[4],[{name:"review_goal",args:goalCheck("blocked",[])}]); await tick(); complete(h.streams[5]); await image;
  assert.equal(sessions().current().messages.at(-1).goalProgress.status,"blocked");
});

test("Goal 达到修正上限后拒绝更多生图，停止会取消请求并保留停止状态", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  sessions().setGoal({ enabled: true, maxCorrections: 0 });
  const pending = sessions().send("两个人", []);
  callTool(h.streams[0], [{ args: { prompt: "两个人" } }]); await tick();
  h.imageCalls[0].resolve([generated("initial", "image-test")]); await tick();
  callTool(h.streams[1], [{ name: "edit_image", args: { prompt: "修正", source_image_ids: ["image_initial"] } }]); await tick();
  assert.equal(h.imageCalls.length, 1); assert.equal(h.streams[2].request.tools, null);
  complete(h.streams[2], "已达到上限"); await pending;
  assert.equal(sessions().current().messages.at(-1).goalProgress.status, "limit");
  sessions().setGoal({ maxCorrections: 3 }); h.backgroundState.enabled = true;
  const next = sessions().send("继续修正", []);
  await tick();
  callTool(h.streams[3], [{ args: { prompt: "新图" } }]); await tick();
  sessions().stop(); await next;
  assert.equal(h.imageCalls[1].canceled, true); assert.equal(h.backgroundTasks.at(-1).finished, true);
  assert.equal(sessions().current().messages.at(-1).goalProgress.status, "stopped");
});

test("生图失败仅由 Chat 决定重试或切换，保留完整请求且不泄露连接信息", async () => {
  const h = await harness(); const sessions = h.useSessions.getState; const cfg = h.useConfig.getState().config;
  h.useConfig.setState({config:{...cfg,image:{...cfg.image,modelPool:[{id:"A",apiMode:"images"},{id:"B",apiMode:"chat",baseUrl:"https://backup.example.test/v1",apiKey:"backup-test-key"}]}}});
  const pending = sessions().send("组合素材，保留你好", [attachment("a"), attachment("b")]);
  const [initial] = callTool(h.streams[0], [{name:"edit_image",args:{model:"A",prompt:"保留文字，组合",size:"1536x1024",source_image_ids:["b","a"]}}]); await tick();
  h.imageCalls[0].reject(new Error(`服务错误 ${cfg.image.apiKey} ${cfg.image.baseUrl}`)); await tick();
  assert.equal(h.imageCalls.length,1,"应用不会自行发起下一次生图");
  const failure = sessions().current().messages.at(-1).content;
  assert.ok(failure.includes(initial.id)); assert.ok(!failure.includes(cfg.image.apiKey)); assert.ok(!failure.includes(cfg.image.baseUrl));
  const [retry] = callTool(h.streams[1],[{name:"retry_image",args:{failed_call_id:initial.id,model:"A"}}]); await tick();
  assert.deepEqual(h.imageCalls[1].request,h.imageCalls[0].request);
  h.imageCalls[1].reject(new Error("模型繁忙")); await tick();
  callTool(h.streams[2],[{name:"retry_image",args:{failed_call_id:retry.id,model:"B"}}]); await tick();
  const alternate=h.imageCalls[2].request;
  assert.equal(alternate.model,"B"); assert.equal(alternate.apiMode,"chat"); assert.equal(alternate.apiKey,"backup-test-key");
  assert.equal(alternate.prompt,h.imageCalls[0].request.prompt); assert.equal(alternate.size,"1536x1024");
  assert.deepEqual(alternate.images,[attachment("b").dataUrl,attachment("a").dataUrl]);
  h.imageCalls[2].resolve([generated("fixed","B")]); await tick(); complete(h.streams[3]); await pending;
  const retried=sessions().current().messages.flatMap(message=>message.toolCalls??[]).at(-1);
  assert.equal(retried.retryOf,retry.id); assert.equal(retried.requestedSize,"1536x1024");
});

test("重试不能切换用户固定模型，Goal 设置和停止在并发会话间隔离", async () => {
  const h = await harness(); const sessions = h.useSessions.getState; const cfg=h.useConfig.getState().config;
  h.useConfig.setState({config:{...cfg,image:{...cfg.image,modelPool:[{id:"A",apiMode:"images"},{id:"B",apiMode:"chat"}]}}});
  sessions().setImageModel("A"); sessions().setGoal({enabled:true,level:"strict",maxCorrections:2});
  const first=sessions().currentId; const p1=sessions().send("第一目标",[]);
  const [failed]=callTool(h.streams[0],[{args:{model:"A",prompt:"目标"}}]); await tick(); h.imageCalls[0].reject(new Error("繁忙")); await tick();
  sessions().newSession(); const second=sessions().currentId; const p2=sessions().send("普通会话",[]);
  assert.equal(sessions().current().goal,undefined); complete(h.streams[2]); await p2;
  callTool(h.streams[1],[{name:"retry_image",args:{failed_call_id:failed.id,model:"B"}}]); await tick();
  assert.equal(h.imageCalls.length,1);
  assert.ok(sessions().sessions.find(s=>s.id===first).messages.at(-1).content.includes("指定"));
  sessions().stop(first); await p1;
  assert.equal(sessions().sessions.find(s=>s.id===first).messages.at(-1).goalProgress.status,"stopped");
  assert.equal(sessions().currentId,second);
});

test("Chat 分别调用 A、B 生成中间素材，再把实际结果图交给 C 合成和回图检查", async () => {
  const h = await harness(); const sessions = h.useSessions.getState;
  const cfg = h.useConfig.getState().config;
  h.useConfig.setState({ config: { ...cfg, image: { ...cfg.image, modelPool: [
    { id: "model-A", apiMode: "images", supportsEditing: false, description: "人物素材" },
    { id: "gemini-model-B", apiMode: "auto", description: "背景素材" },
    { id: "model-C", apiMode: "gemini", baseUrl: "https://native.example.test/v1beta", apiKey: "C-test-key", description: "最终合成" },
  ] } } });
  const pending = sessions().send("A 生成猫，B 生成背景，再由 C 组合", []);
  assert.ok(h.streams[0].request.messages[1].content.includes("最终合成"));
  assert.ok(h.streams[0].request.messages[1].content.includes("不能编造"));
  callTool(h.streams[0], [{ args: { model: "model-A", prompt: "只生成猫素材", stage: "asset" } }]);
  await tick();
  assert.equal(h.imageCalls[0].request.model, "model-A");
  assert.equal(h.imageCalls[0].request.apiMode, "images");
  assert.ok(h.imageCalls[0].request.prompt.includes("不执行其他模型的步骤或提前合成"));
  h.imageCalls[0].resolve([generated("cat", "model-A")]); await tick();
  callTool(h.streams[1], [{ args: { model: "gemini-model-B", prompt: "只生成背景素材", stage: "asset" } }]); await tick();
  assert.equal(h.imageCalls[1].request.apiMode, "chat");
  h.imageCalls[1].resolve([generated("background", "gemini-model-B")]); await tick();
  callTool(h.streams[2], [{ name: "edit_image", args: { model: "model-C", prompt: "将猫放入背景", stage: "final", source_image_ids: ["image_background", "image_cat"] } }]); await tick();
  const combined = h.imageCalls[2].request;
  assert.equal(combined.model, "model-C");
  assert.equal(combined.apiMode, "gemini");
  assert.equal(combined.baseUrl, "https://native.example.test/v1beta");
  assert.equal(combined.apiKey, "C-test-key");
  assert.deepEqual(combined.images, [attachment("background").dataUrl, attachment("cat").dataUrl]);
  assert.equal(h.imageCalls[2].parentId, "background");
  const calls = sessions().current().messages.flatMap((message) => message.toolCalls ?? []);
  assert.deepEqual(calls.map((call) => call.imageModel), ["model-A", "gemini-model-B", "model-C"]);
  assert.deepEqual(calls.map((call) => call.imageStage), ["asset", "asset", "final"]);
  h.imageCalls[2].resolve([generated("final", "model-C")]); await tick();
  assert.ok(JSON.stringify(h.streams[3].request.messages).includes(attachment("final").dataUrl));
  complete(h.streams[3], "猫与背景合成完成，检查符合要求"); await pending;
  await sessions().persist();
  assert.equal(h.saves.at(-1).sessions[0].messages.at(-1).content, "猫与背景合成完成，检查符合要求");
});

test("同轮的 A、B 工具结果全部回传后才向 C 提供组合素材", async () => {
  const h = await harness(); const cfg = h.useConfig.getState().config;
  h.useConfig.setState({ config: { ...cfg, image: { ...cfg.image, modelPool: ["A", "B", "C"].map((id) => ({ id, apiMode: "auto" })) } } });
  const pending = h.useSessions.getState().send("分别生成再组合", []);
  callTool(h.streams[0], [{ args: { model: "A", prompt: "主体", stage: "asset" } }, { args: { model: "B", prompt: "背景", stage: "asset" } }]); await tick();
  h.imageCalls[0].resolve([generated("a", "A")]); await tick();
  assert.equal(h.streams.length, 1);
  h.imageCalls[1].resolve([generated("b", "B")]); await tick();
  assert.deepEqual(h.streams[1].request.messages.slice(-5).map((message) => message.role), ["assistant", "tool", "tool", "user", "user"]);
  callTool(h.streams[1], [{ name: "edit_image", args: { model: "C", prompt: "组合", source_image_ids: ["image_a", "image_b"] } }]); await tick();
  assert.deepEqual(h.imageCalls[2].request.images, [attachment("a").dataUrl, attachment("b").dataUrl]);
  h.imageCalls[2].resolve([generated("c", "C")]); await tick(); complete(h.streams[2]); await pending;
});

test("每个并发会话保留独立指定模型，工具省略模型也遵守该选择", async () => {
  const h = await harness(); const cfg = h.useConfig.getState().config; const sessions = h.useSessions.getState;
  h.useConfig.setState({ config: { ...cfg, image: { ...cfg.image, modelPool: ["A", "B"].map((id) => ({ id, apiMode: "auto" })) } } });
  const first = sessions().currentId;
  sessions().setImageModel("A"); const p1 = sessions().send("第一张", []);
  sessions().setImageModel("B"); assert.equal(sessions().current().imageModel, "A", "运行中的模型不能被改变");
  sessions().newSession(); sessions().setImageModel("B"); const p2 = sessions().send("第二张", []);
  callTool(h.streams[0], [{ args: { prompt: "主体" } }]); await tick();
  callTool(h.streams[1], [{ args: { prompt: "背景" } }]); await tick();
  assert.deepEqual(h.imageCalls.map((call) => call.request.model), ["A", "B"]);
  h.imageCalls[0].resolve([generated("a", "A")]); await tick(); complete(h.streams[2]); await p1;
  h.imageCalls[1].resolve([generated("b", "B")]); await tick(); complete(h.streams[3]); await p2;
  await sessions().persist();
  assert.equal(h.saves.at(-1).sessions.find((session) => session.id === first).imageModel, "A");
});

test("未启用模型与仅文生图模型的编辑不会发起图像请求", async () => {
  const h = await harness(); const cfg = h.useConfig.getState().config;
  h.useConfig.setState({ config: { ...cfg, image: { ...cfg.image, modelPool: [{ id: "A", apiMode: "auto", supportsEditing: false }] } } });
  const pending = h.useSessions.getState().send("组合参考图", [attachment("ref")]);
  callTool(h.streams[0], [{ args: { model: "unknown", prompt: "生成" } }, { name: "edit_image", args: { model: "A", prompt: "编辑", source_image_ids: ["ref"] } }]); await tick();
  assert.equal(h.imageCalls.length, 0);
  const failures = h.useSessions.getState().current().messages.filter((message) => message.role === "tool").map((message) => message.content);
  assert.ok(failures[0].includes("未启用")); assert.ok(failures[1].includes("仅文生图"));
  complete(h.streams[1], "请配置可合成的模型"); await pending;
});

test("模型池多选界面展示全部模型与逐模型协议、能力和连接设置", async () => {
  const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
  const ui = `data:text/javascript,${encodeURIComponent("export const Field = ({children}) => children;")}`;
  const url = await compile("src/components/ImageModelPool.tsx", { react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"), "./ui": ui, "../lib/imageModels": imageModelsUrl });
  const { ImageModelPool } = await import(url); const h = await harness();
  const config = { ...h.useConfig.getState().config.image, models: ["A", "gemini-B", "flux-C"], modelPool: [{ id: "A", apiMode: "auto" }, { id: "gemini-B", apiMode: "chat" }] };
  const html = renderToStaticMarkup(createElement(ImageModelPool, { config, onChange() {}, onBlur() {}, onFetch() {} }));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((html.match(/checked=""/g) ?? []).length, 2);
  assert.ok(html.includes("完成选择")); assert.ok(html.includes("gemini-B 接口类型"));
  assert.ok(html.includes("A 模型能力")); assert.ok(html.includes("A API Key"));
  assert.ok(html.includes('aria-expanded="true"')); assert.ok(html.includes("拉取可选模型"));
});

test("Android 返回键逐层关闭界面，首页连续两次才返回桌面并保存状态", async () => {
  const { createBackHandler } = await import(await compile("src/lib/androidBack.ts"));
  const calls = []; let preview = true; let panel = true; let otherTab = true; let now = 0;
  const back = createBackHandler({
    closePreview: () => { calls.push("preview"); if (preview) { preview = false; return true; } return false; },
    closePanel: () => { calls.push("panel"); if (panel) { panel = false; return true; } return false; },
    returnHome: () => { calls.push("home"); if (otherTab) { otherTab = false; return true; } return false; },
    notify: () => calls.push("notify"), persist: () => calls.push("persist"),
  }, () => now);
  assert.equal(back(), "handled"); assert.deepEqual(calls, ["preview"]);
  assert.equal(back(), "handled"); assert.deepEqual(calls.slice(-2), ["preview", "panel"]);
  assert.equal(back(), "handled"); assert.equal(calls.at(-1), "home");
  assert.equal(back(), "handled"); assert.equal(calls.at(-1), "notify");
  now = 2100; assert.equal(back(), "handled"); assert.equal(calls.at(-1), "notify");
  preview = true; assert.equal(back(), "handled");
  assert.equal(back(), "handled", "关闭预览后重置两次返回计时");
  now += 500; assert.equal(back(), "exit"); assert.equal(calls.at(-1), "persist");
});

test("Android 保存原图默认调用相册，另存为仍可选择系统文档目录", async () => {
  const state = globalThis.__albumSaveTest = { album: [], writes: [], dialogs: 0, reads: [], fail: false };
  const api = `data:text/javascript,${encodeURIComponent("export async function readImageDataUrl(path) { globalThis.__albumSaveTest.reads.push(path); return 'data:image/png;base64,YQ=='; } export async function saveImageToAlbum(dataUrl,fileName) { const s=globalThis.__albumSaveTest; s.album.push({dataUrl,fileName}); if(s.fail) throw new Error('album failed'); return 'content://media/external/images/42'; }")}`;
  const dialog = `data:text/javascript,${encodeURIComponent("export async function save() { globalThis.__albumSaveTest.dialogs++; return 'content://documents/custom.png'; }")}`;
  const fs = `data:text/javascript,${encodeURIComponent("export async function writeFile(path,bytes) { globalThis.__albumSaveTest.writes.push({path,bytes}); }")}`;
  const platform = `data:text/javascript,${encodeURIComponent("export const isAndroid=true;")}`;
  const image = await compile("src/lib/image.ts");
  const { saveImage } = await import(await compile("src/lib/save.ts", { "./api": api, "./image": image, "./platform": platform, "@tauri-apps/plugin-dialog": dialog, "@tauri-apps/plugin-fs": fs }));
  assert.equal(await saveImage({path:'history.png'}),'content://media/external/images/42');
  assert.equal(state.album[0].dataUrl,'data:image/png;base64,YQ==');
  assert.equal(state.dialogs,0); assert.equal(state.writes.length,0);
  await saveImage({dataUrl:'data:image/png;base64,YQ=='},'file');
  assert.equal(state.dialogs,1); assert.equal(state.writes[0].path,'content://documents/custom.png');
  state.fail=true; await assert.rejects(saveImage({dataUrl:'data:image/png;base64,YQ=='}),/album failed/);
  assert.equal(state.dialogs,1,"相册失败不能悄悄改为文件保存");
});

test("Chat 控制编辑/合成尺寸，省略沿用设置，显式 auto 不强制默认尺寸", async () => {
  const { imageToolSize } = await import(imageSizeUrl);
  assert.equal(imageToolSize(undefined, "1536x1024"), "1536x1024");
  assert.equal(imageToolSize("auto", "1536x1024"), undefined);
  assert.equal(imageToolSize("2048×2048", "auto"), "2048x2048");
  assert.throws(() => imageToolSize("invalid", "auto"), /尺寸格式/);
  const h=await harness();const cfg=h.useConfig.getState().config;
  h.useConfig.setState({config:{...cfg,image:{...cfg.image,size:"1024x1024"}}});
  assert.ok(h.imageTools(cfg.image)[1].function.parameters.properties.size);
  const pending=h.useSessions.getState().send("合成输出 2048x2048",[attachment("ref")]);
  callTool(h.streams[0],[{name:"edit_image",args:{prompt:"组合",size:"2048x2048",source_image_ids:["ref"]}}]);await tick();
  assert.equal(h.imageCalls[0].request.size,"2048x2048");
  h.imageCalls[0].resolve([generated("g","image-test")]);await tick();complete(h.streams[1]);await pending;
});
