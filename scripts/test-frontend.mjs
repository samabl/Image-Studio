import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import vm from "node:vm";

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
const juryUrl = await compile("src/lib/jury.ts", { "./chat": chatUrl });
const jury = await import(juryUrl);
const codeWorkerSource = await readFile(new URL("../src/lib/codeWorker.js", import.meta.url), "utf8");
const codeWorkerUrl = `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(codeWorkerSource)};`)}`;
const codeRuntimeUrl = await compile("src/lib/codeRuntime.ts", { "./codeWorker.js?raw": codeWorkerUrl });
const codeRuntime = await import(codeRuntimeUrl);
const codeMockUrl = `data:text/javascript,${encodeURIComponent(`export { codeRuntimeSettings, codeImageTool, codeImageInstructions } from ${JSON.stringify(codeRuntimeUrl)}; export const startCodeEdit = (...args) => globalThis.__studioTestApi.startCodeEdit(...args);`)}`;
const numberInput = await import(await compile("src/lib/numberInput.ts"));
const preview = await import(await compile("src/lib/preview.ts"));
const gallery = await import(await compile("src/lib/gallery.ts"));
const attachment = (id) => ({ id, dataUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`, name: `${id}.png` });
const message = (role, extra = {}) => ({ id: `${role}_${Math.random()}`, role, content: "", createdAt: 1, ...extra });

test("主按钮在鼠标悬停或移动端触摸后仍保留高对比背景", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.btn:not\(\.primary\):hover:not\(:disabled\)/);
  assert.match(css, /\.btn\.primary\s*\{[^}]*background:\s*linear-gradient/);
  assert.doesNotMatch(css, /\.btn:hover:not\(:disabled\)\s*\{[^}]*background:/);
});

test("设置开关保留键盘焦点与可访问的 switch 角色", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const ui = await readFile(new URL("../src/components/ui.tsx", import.meta.url), "utf8");
  assert.match(ui, /type="checkbox" role="switch"/);
  assert.doesNotMatch(css, /\.switch input\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.switch input:focus-visible \+ \.track/);
});

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
  const codeCalls = [];
  const outputSaves = [];
  const archives = [];
  let galleryItems = [];
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
      return { promise, cancel: () => { call.canceled = true; if (!call.deferCancel) reject(new Error("已停止")); } };
    },
    readImageDataUrl: async () => attachment("disk").dataUrl,
    cancellableText: (request) => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const task = { request, resolve, reject, canceled: false }; textCalls.push(task);
      return { promise, cancel: () => { task.canceled = true; reject(new Error("已停止")); } };
    },
    chatOnce: async (request) => { api.onceRequest = request; return "优化后的提示词"; },
    startCodeEdit: (sources, code, config) => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const task = { sources, code, config, resolve, reject, canceled: false }; codeCalls.push(task);
      return { promise, cancel: () => { task.canceled = true; reject(new Error("已停止代码执行")); } };
    },
    saveImageOutputs: async (dataUrls, meta) => {
      outputSaves.push({ dataUrls, meta });
      return dataUrls.map((dataUrl, index) => ({ id: `code_${outputSaves.length}_${index}`, path: `outputs/code_${index}.png`, dataUrl,
        kind: meta.kind, model: meta.model, prompt: meta.prompt, size: "100x100", parentId: meta.parentId, createdAt: 1 }));
    },
    galleryArchive: async (item) => {
      archives.push(item);
      const saved = { ...item, path: `gallery/${item.id}.png`, fileName: `${item.id}.png` };
      if (!galleryItems.some((stored) => stored.id === item.id)) galleryItems.push(saved);
      return saved;
    },
    galleryList: async () => galleryItems,
    galleryDelete: async (ids) => { galleryItems = galleryItems.filter((item) => !ids.includes(item.id)); },
    galleryClear: async () => { galleryItems = []; },
  };
  globalThis.__studioTestApi = api;
  const apiUrl = `data:text/javascript,${encodeURIComponent(Object.keys(api).map((name) => `export const ${name} = (...args) => globalThis.__studioTestApi.${name}(...args);`).join("\n"))}`;
  const imageUrl = await compile("src/lib/image.ts");
  const storeUrl = await compile("src/lib/store.ts", { zustand: import.meta.resolve("zustand"), "./api": apiUrl, "./image": imageUrl, "./chat": chatUrl, "./imageModels": imageModelsUrl, "./imageSize": imageSizeUrl, "./goal": goalUrl, "./jury": juryUrl, "./codeRuntime": codeMockUrl });
  const store = await import(`${storeUrl}#${++harnessId}`);
  store.useConfig.setState({ ready: true, config: {
    chat: { protocol: "openai", baseUrl: "https://example.test", apiKey: "test-key", model: "test-model", systemPrompt: "测试", maxTokens: 4096, temperature: null, timeoutSecs: 30, stream: true, models: [] },
    image: { baseUrl: "https://example.test", apiKey: "test-key", model: "image-test", apiMode: "images", timeoutSecs: 30, size: "auto", n: 1, quality: "auto", background: "auto", outputFormat: "auto", models: [] },
    linkage: { enabled: true, useTools: true, autoOptimizePrompt: false, visionModel: "", optimizeSystemPrompt: "优化", reverseSystemPrompt: "反推" }, ui: { sendOnEnter: true },
  } });
  await store.useSessions.getState().init();
  return { ...store, streams, imageCalls, textCalls, codeCalls, outputSaves, archives, saves, api, backgroundTasks, backgroundState };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const complete = (stream, text = "完成") => { stream.onEvent({ type: "delta", text }); stream.onEvent({ type: "done", finishReason: "stop" }); };

const reviewer = (id, patch = {}) => ({ id, name: id, enabled: true, model: `vision-${id}`, inheritChat: true, protocol: "openai", baseUrl: "", apiKey: "", focus: "", models: [], ...patch });
const withJury = (config, patch = {}) => ({ ...config, jury: { enabled: true, includeChat: false, members: [reviewer("a"),reviewer("b")], ...patch } });

test("评审团默认关闭，Chat 可独立参与，每位成员使用自己的模型和连接", async () => {
  const h = await harness(); const config = withJury(h.useConfig.getState().config, { includeChat: true, members: [reviewer("a"),reviewer("b", { inheritChat: false, protocol: "anthropic", baseUrl: "https://vision.test", apiKey: "vision-test-key" }),reviewer("disabled", { enabled: false })] });
  config.linkage.visionModel = "not-the-chat-model";
  assert.deepEqual(jury.jurySettings(), { enabled: false, includeChat: true, members: [] });
  const members = jury.juryMembers(config);
  assert.deepEqual(members.map((member) => member.model), [config.chat.model,"vision-a","vision-b"]);
  assert.deepEqual(jury.juryConnection(members[2], config), { protocol: "anthropic", baseUrl: "https://vision.test", apiKey: "vision-test-key" });
  assert.equal(jury.juryMembers({ ...config, jury: { ...config.jury, enabled: false } }).length, 0);
  assert.equal(jury.juryMembers(withJury(config, { includeChat: true, members: Array.from({length:20}, (_, i) => reviewer(`${i}`)) })).length, 13);
});

test("每份评审请求包含原始约束和实际图片，不掺入其他评审意见", async () => {
  const h = await harness(); const config = withJury(h.useConfig.getState().config);
  const request = jury.juryRequest(reviewer("a", { focus: "检查文字" }), config, { requirements: "保留两个人", prompt: "保持数量", goal: "严格", focus: "检查边缘", references: [{id:"ref",label:"原图",dataUrl:attachment("ref").dataUrl}], images: [{id:"out",label:"结果",dataUrl:attachment("out").dataUrl}] });
  assert.equal(request.tools, null); assert.equal(request.stream, false);
  assert.deepEqual(request.messages[1].content.filter((part) => part.type === "image_url").map((part) => part.image_url.url), [attachment("ref").dataUrl,attachment("out").dataUrl]);
  assert.match(request.messages[1].content[0].text, /保留两个人/); assert.match(request.messages[1].content[0].text, /检查文字/);
  assert.ok(JSON.stringify(request.messages).includes("参考图 1")); assert.ok(JSON.stringify(request.messages).includes("待评审结果 1"));
  assert.throws(() => jury.juryRequest(reviewer("a", { inheritChat: false, protocol: "toString", baseUrl: "x", apiKey: "x" }), config, { requirements: "", images: [{dataUrl:attachment("ref").dataUrl}] }), /协议/);
});

test("独立评审并行执行，单成员失败不阻断其余意见，保存前隐藏连接信息", async () => {
  const h = await harness(); const config = withJury(h.useConfig.getState().config); const tasks = [], updates = [];
  const review = jury.startJuryReview(config, { requirements: "两个人", images: [{id:"out",label:"结果",dataUrl:attachment("out").dataUrl}] }, (request) => {
    let resolve, reject; const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
    tasks.push({request,resolve,reject}); return { promise, cancel: () => {} };
  }, (report) => updates.push(report));
  assert.equal(tasks.length, 2); assert.equal(updates[0].status, "reviewing");
  tasks[0].reject(new Error(`HTTP error ${config.chat.baseUrl} Authorization: Bearer ${config.chat.apiKey}`)); await tick();
  assert.equal(updates.at(-1).opinions[0].status, "error"); assert.equal(updates.at(-1).opinions[1].status, "pending");
  tasks[1].resolve("符合数量，建议改善边缘"); const report = await review.promise;
  assert.equal(report.status, "partial"); assert.equal(report.opinions[1].text, "符合数量，建议改善边缘");
  assert.ok(!JSON.stringify(report).includes(config.chat.apiKey)); assert.ok(!JSON.stringify(report).includes(config.chat.baseUrl));
  assert.equal(updates[0].opinions[0].status, "pending", "发布的是独立快照");
});

test("取消评审立即收束所有成员，迟到意见不能覆盖已停止状态", async () => {
  const h = await harness(); const config = withJury(h.useConfig.getState().config); const tasks=[], updates=[];
  const review = jury.startJuryReview(config, { requirements: "", images: [{id:"out",label:"结果",dataUrl:attachment("out").dataUrl}] }, () => {
    let resolve; const promise = new Promise((res) => { resolve=res; }); const task={resolve,canceled:false}; tasks.push(task);
    return { promise, cancel: () => { task.canceled=true; } };
  }, (report) => updates.push(report));
  review.cancel(); const report=await review.promise;
  assert.equal(report.status, "stopped"); assert.ok(tasks.every((task) => task.canceled)); assert.ok(report.opinions.every((opinion) => opinion.status === "stopped"));
  const count=updates.length; tasks.forEach((task) => task.resolve("迟到意见")); await tick(); assert.equal(updates.length, count);
});

test("最终成图自动评审，全部意见交给主 Chat 汇总而非增加另一轮总结请求", async () => {
  const h=await harness(); h.useConfig.setState({config:withJury(h.useConfig.getState().config,{includeChat:true})});
  const pending=h.useSessions.getState().send("两个人，保留文字",[attachment("ref")]);
  callTool(h.streams[0],[{args:{prompt:"两个人，保留文字"}}]); await tick();
  h.imageCalls[0].resolve([generated("out","image-test")]); await tick();
  assert.equal(h.textCalls.length,3); assert.equal(h.streams.length,1);
  assert.ok(h.textCalls.every((task) => JSON.stringify(task.request.messages).includes(attachment("out").dataUrl)));
  assert.equal(h.textCalls[0].request.model,"test-model");
  h.textCalls[0].resolve("Chat：人数正确"); h.textCalls[1].resolve("文字正确，边缘需修正"); await tick(); assert.equal(h.streams.length,1);
  h.textCalls[2].reject(new Error("不支持看图")); await tick();
  const tool=h.useSessions.getState().current().messages.find((message) => message.juryReview);
  assert.equal(tool.juryReview.status,"partial"); assert.equal(tool.pending,false); assert.equal(tool.images.length,1);
  assert.match(JSON.stringify(h.streams[1].request.messages),/文字正确，边缘需修正/);
  assert.match(JSON.stringify(h.streams[1].request.messages),/不支持看图/);
  assert.ok(JSON.stringify(h.streams[1].request.messages).includes(attachment("out").dataUrl));
  assert.equal(h.useGallery.getState().items.length,0); assert.equal(h.archives.length,0);
  complete(h.streams[1],"采纳边缘建议；评审失败不代表通过"); await pending;
});

test("中间素材不自动评审；手动评审可在关闭图像联动时使用历史图片", async () => {
  const h=await harness(); const cfg=withJury(h.useConfig.getState().config); h.useConfig.setState({config:cfg});
  const pending=h.useSessions.getState().send("生成素材",[]); callTool(h.streams[0],[{args:{prompt:"素材",stage:"asset"}}]); await tick();
  h.imageCalls[0].resolve([generated("asset","image-test")]); await tick(); assert.equal(h.textCalls.length,0); complete(h.streams[1]); await pending;
  h.useConfig.setState({config:{...cfg,linkage:{...cfg.linkage,enabled:false}}});
  const review=h.useSessions.getState().send("只评审已有图",[]);
  assert.deepEqual(h.streams[2].request.tools.map((tool) => tool.function.name),["review_images"]);
  callTool(h.streams[2],[{name:"review_images",args:{source_image_ids:["image_asset"],focus:"检查构图"}}]); await tick();
  assert.equal(h.imageCalls.length,1); assert.equal(h.textCalls.length,2);
  h.textCalls.forEach((task) => task.resolve("构图合适")); await tick(); complete(h.streams[3]); await review;
});

test("停止评审保留已经生成的图片，取消每位评审且不再调用主 Chat", async () => {
  const h=await harness();h.useConfig.setState({config:withJury(h.useConfig.getState().config)});
  const pending=h.useSessions.getState().send("生成",[]);callTool(h.streams[0],[{args:{prompt:"生成"}}]);await tick();
  h.imageCalls[0].resolve([generated("out","image-test")]);await tick();h.useSessions.getState().stop();await pending;
  const tool=h.useSessions.getState().current().messages.find((message) => message.juryReview);
  assert.equal(tool.juryReview.status,"stopped");assert.equal(tool.images.length,1);assert.equal(tool.pending,false);
  assert.ok(h.textCalls.every((task) => task.canceled));assert.equal(h.streams.length,1);
});

const codeOutput = (id="pixels") => ({dataUrls:[attachment(id).dataUrl],sizes:["100x100"],logs:["已修改像素"],elapsedMs:2});
test("Chat 代码编辑独立于图像 API，输入顺序、元数据和实际回图完整保留且不入库", async () => {
  const h=await harness();const cfg=h.useConfig.getState().config;
  h.useConfig.setState({config:{...cfg,linkage:{...cfg.linkage,enabled:false},codeRuntime:{enabled:true,timeoutSecs:7}}});
  const pending=h.useSessions.getState().send("组合两张图",[attachment("a"),{...attachment("b"),galleryId:"base"}]);
  assert.deepEqual(h.streams[0].request.tools.map((tool) => tool.function.name),["edit_image_code"]);
  callTool(h.streams[0],[{name:"edit_image_code",args:{source_image_ids:["b","a"],description:"精确拼接",code:"return image.clone(images[0]);"}}]);await tick();
  assert.deepEqual(h.codeCalls[0].sources.map((source) => source.id),["b","a"]);assert.equal(h.codeCalls[0].config.timeoutSecs,7);
  h.codeCalls[0].resolve(codeOutput());await tick();
  assert.equal(h.imageCalls.length,0);assert.equal(h.outputSaves[0].meta.model,"builtin-js");assert.equal(h.outputSaves[0].meta.parentId,"base");
  const tool=h.useSessions.getState().current().messages.find((message) => message.codeExecution);
  assert.equal(tool.codeExecution.status,"complete");assert.deepEqual(tool.codeExecution.outputSizes,["100x100"]);
  assert.equal(tool.images[0].kind,"edit");assert.equal(tool.images[0].createdAt,1);assert.equal(tool.images[0].parentId,"base");
  assert.ok(JSON.stringify(h.streams[1].request.messages).includes(attachment("pixels").dataUrl));
  assert.equal(h.useGallery.getState().items.length,0);assert.equal(h.archives.length,0);
  complete(h.streams[1]);await pending;
});

test("代码输出接入评审团，停止时保留代码成图并取消评审", async () => {
  const h=await harness();const cfg=withJury(h.useConfig.getState().config);h.useConfig.setState({config:{...cfg,codeRuntime:{enabled:true,timeoutSecs:10}}});
  const pending=h.useSessions.getState().send("绘制",[attachment("ref")]);callTool(h.streams[0],[{name:"edit_image_code",args:{source_image_ids:["ref"],description:"绘制",code:"return images[0];"}}]);await tick();
  h.codeCalls[0].resolve(codeOutput());await tick();assert.equal(h.textCalls.length,2);assert.equal(h.streams.length,1);
  h.useSessions.getState().stop();await pending;
  const tool=h.useSessions.getState().current().messages.find((message) => message.codeExecution);
  assert.equal(tool.codeExecution.status,"complete");assert.equal(tool.juryReview.status,"stopped");assert.equal(tool.images.length,1);
});

test("代码执行失败可由 Chat 修正代码，取消不会保存迟到结果", async () => {
  const h=await harness();const cfg=h.useConfig.getState().config;h.useConfig.setState({config:{...cfg,codeRuntime:{enabled:true,timeoutSecs:10}}});
  const pending=h.useSessions.getState().send("修改",[attachment("ref")]);callTool(h.streams[0],[{name:"edit_image_code",args:{source_image_ids:["ref"],description:"修改",code:"bad();"}}]);await tick();
  h.codeCalls[0].reject(new Error("bad is not defined"));await tick();
  const failed=h.useSessions.getState().current().messages.find((message) => message.codeExecution);
  assert.equal(failed.codeExecution.status,"error");assert.ok(!failed.content.includes("failed_call_id"));
  callTool(h.streams[1],[{name:"edit_image_code",args:{source_image_ids:["ref"],description:"重试",code:"return images[0];"}}]);await tick();
  h.useSessions.getState().stop();await pending;h.codeCalls[1].resolve(codeOutput());await tick();
  assert.equal(h.codeCalls[1].canceled,true);assert.equal(h.outputSaves.length,0);assert.equal(h.streams.length,2);
  assert.equal(h.useSessions.getState().current().messages.filter((message) => message.codeExecution).at(-1).codeExecution.status,"stopped");
});

test("Goal 可只使用内置 JS，代码成图也遵守修正上限", async () => {
  const h=await harness();const cfg=h.useConfig.getState().config;h.useConfig.setState({config:{...cfg,linkage:{...cfg.linkage,enabled:false},codeRuntime:{enabled:true,timeoutSecs:10}}});
  h.useSessions.getState().setGoal({enabled:true,maxCorrections:0});const pending=h.useSessions.getState().send("精确修改",[attachment("ref")]);
  assert.deepEqual(h.streams[0].request.tools.map((tool) => tool.function.name),["review_goal","edit_image_code"]);
  const edit={name:"edit_image_code",args:{source_image_ids:["ref"],description:"修改",code:"return images[0];"}};
  callTool(h.streams[0],[edit]);await tick();h.codeCalls[0].resolve(codeOutput());await tick();
  callTool(h.streams[1],[edit]);await tick();assert.equal(h.codeCalls.length,1);assert.equal(h.streams[2].request.tools,null);
  complete(h.streams[2],"已达到修正上限");await pending;
  const progress=h.useSessions.getState().current().messages.at(-1).goalProgress;
  assert.equal(progress.status,"limit");assert.equal(progress.attempts,1);assert.equal(progress.corrections,0);
});

test("排队发送严格 FIFO，附件提交时复制且队列推进不清空新草稿", async () => {
  const h=await harness();const sessions=h.useSessions.getState;const first=sessions().send("第一条",[]);
  const atts=[attachment("queued")];await sessions().send("第二条",atts,"queue");atts[0].name="changed.png";
  await sessions().send("第三条",[],"queue");sessions().setDraftText("下一条还在写");sessions().addDraftAtts([attachment("draft")]);
  assert.equal(h.streams.length,1);assert.equal(sessions().current().queuedMessages.length,2);
  complete(h.streams[0]);await first;await tick();
  assert.equal(h.streams.length,2);assert.equal(sessions().current().draftText,"下一条还在写");assert.equal(sessions().current().draftAtts[0].id,"draft");
  assert.equal(sessions().current().messages.filter((message) => message.role === "user")[1].attachments[0].name,"queued.png");
  complete(h.streams[1]);await tick();assert.equal(h.streams.length,3);complete(h.streams[2]);await tick();
  assert.deepEqual(sessions().current().messages.filter((message) => message.role === "user").map((message) => message.content),["第一条","第二条","第三条"]);
  assert.equal(sessions().current().queuedMessages.length,0);assert.equal(Object.keys(sessions().runs).length,0);
});

test("插话优先于队列，保留旧回答片段并忽略取消后的事件", async () => {
  const h=await harness();const sessions=h.useSessions.getState;const first=sessions().send("原请求",[]);
  h.streams[0].onEvent({type:"delta",text:"已写的片段"});await sessions().send("原队列",[],"queue");await sessions().send("新要求",[],"interrupt");
  await first;await tick();assert.equal(h.streams[0].canceled,true);assert.equal(h.streams.length,2);
  h.streams[0].onEvent({type:"delta",text:"迟到片段"});h.streams[0].onEvent({type:"done",finishReason:"stop"});
  assert.equal(sessions().current().messages.find((message) => message.role === "assistant").content,"已写的片段");
  complete(h.streams[1]);await tick();complete(h.streams[2]);await tick();
  assert.deepEqual(sessions().current().messages.filter((message) => message.role === "user").map((message) => message.content),["原请求","新要求","原队列"]);
});

test("工具执行中插话等待清理，所有工具响应补齐后才发送新用户消息", async () => {
  const h=await harness();const sessions=h.useSessions.getState;const first=sessions().send("两张图",[]);
  callTool(h.streams[0],[{args:{prompt:"图一"}},{args:{prompt:"图二"}}]);await tick();h.imageCalls[0].deferCancel=true;
  await sessions().send("改成另一种构图",[],"interrupt");assert.equal(h.imageCalls[0].canceled,true);assert.equal(h.streams.length,1);
  h.imageCalls[0].resolve([generated("late","image-test")]);await first;await tick();
  assert.equal(h.imageCalls.length,1);assert.equal(h.streams.length,2);
  const tail=h.streams[1].request.messages.slice(-4);assert.deepEqual(tail.map((message) => message.role),["assistant","tool","tool","user"]);
  assert.ok(tail[1].content.includes("停止"));assert.ok(tail[2].content.includes("停止"));
  assert.ok(!JSON.stringify(h.streams[1].request.messages).includes(attachment("late").dataUrl));
  complete(h.streams[1]);await tick();
});

test("暂停和停止保留队列，新排队不能偷偷恢复，可移除、继续和清空", async () => {
  const h=await harness();const sessions=h.useSessions.getState;const first=sessions().send("当前",[]);
  await sessions().send("移除这条",[],"queue");await sessions().send("保留这条",[],"queue");sessions().pauseQueue();
  sessions().removeQueued(sessions().current().queuedMessages[0].id);await sessions().send("后加的",[],"queue");
  assert.equal(sessions().current().queuePaused,true);complete(h.streams[0]);await first;await tick();assert.equal(h.streams.length,1);
  const resume=sessions().resumeQueue();await tick();assert.equal(h.streams.length,2);sessions().stop();await resume;await tick();
  assert.equal(sessions().current().queuePaused,true);assert.equal(sessions().current().queuedMessages.length,1);
  sessions().clearQueue();assert.equal(sessions().current().queuedMessages.length,0);
  const interrupt=sessions().send("明确插话恢复",[],"interrupt");await tick();assert.equal(sessions().current().queuePaused,false);
  complete(h.streams[2]);await interrupt;
});

test("队列属于原会话，在另一会话编辑时仍不会串消息或清空其草稿", async () => {
  const h=await harness();const sessions=h.useSessions.getState;const a=sessions().currentId;
  const first=sessions().send("A 原消息",[]);await sessions().send("A 排队消息",[],"queue");
  sessions().newSession();const b=sessions().currentId;sessions().setDraftText("B 草稿");
  complete(h.streams[0]);await first;await tick();assert.equal(sessions().currentId,b);assert.equal(sessions().current().draftText,"B 草稿");
  assert.equal(sessions().current().messages.length,0);assert.ok(sessions().runs[a]);assert.ok(!sessions().runs[b]);
  complete(h.streams[1]);await tick();assert.deepEqual(sessions().sessions.find((session) => session.id===a).messages.filter((message) => message.role==="user").map((message) => message.content),["A 原消息","A 排队消息"]);
});

test("重启只恢复队列不自动付费请求，未完成的评审和代码标记为停止", async () => {
  const h=await harness();const original=h.useSessions.getState().current();
  const stored={...original,queuedMessages:[{id:"q",text:"待发送",attachments:[attachment("ref")],mode:"queue",createdAt:1}],queuePaused:false,
    messages:[message("tool",{pending:true,juryReview:{imageIds:["out"],status:"reviewing",createdAt:1,opinions:[{memberId:"a",name:"a",model:"vision-a",status:"pending"}]},codeExecution:{language:"javascript",code:"return images[0]",description:"处理",sourceLabels:[],logs:[],status:"running"}})]};
  h.api.loadState=async()=>JSON.stringify({sessions:[stored],currentId:stored.id});await h.useSessions.getState().init();
  const restored=h.useSessions.getState().current();assert.equal(restored.queuePaused,true);assert.equal(restored.queuedMessages.length,1);
  assert.equal(restored.messages[0].pending,false);assert.equal(restored.messages[0].juryReview.status,"stopped");
  assert.equal(restored.messages[0].juryReview.opinions[0].status,"stopped");assert.equal(restored.messages[0].codeExecution.status,"stopped");
  assert.equal(h.streams.length,0);assert.equal(h.textCalls.length,0);assert.equal(h.codeCalls.length,0);
});

test("结果不自动入库，手动归档并发幂等且完整保留图片来源信息", async () => {
  const h=await harness();const ref={galleryId:"out",path:"outputs/images/out.png",dataUrl:attachment("out").dataUrl,prompt:"原指令",kind:"edit",model:"model",size:"100x100",createdAt:123,parentId:"parent",revisedPrompt:"实际指令"};
  const item=gallery.generatedGalleryItem(ref);assert.equal(item.createdAt,123);assert.equal(item.revisedPrompt,"实际指令");
  const first=h.useGallery.getState().archive(item);const second=h.useGallery.getState().archive(item);assert.deepEqual(h.useGallery.getState().archiving,["out"]);
  const [a,b]=await Promise.all([first,second]);assert.equal(a.id,b.id);assert.equal(h.archives.length,1);assert.equal(h.useGallery.getState().items.length,1);
  assert.equal(h.useGallery.getState().items[0].parentId,"parent");assert.equal(h.useGallery.getState().archiving.length,0);
  await h.useGallery.getState().archive(item);assert.equal(h.archives.length,1);await h.useGallery.getState().remove(["out"]);assert.equal(h.useGallery.getState().items.length,0);
  await h.useGallery.getState().archive(item);assert.equal(h.archives.length,2);
});

test("入库失败不留下已保存状态，用户可重试；兼容旧图片引用", async () => {
  const h=await harness();const item=gallery.generatedGalleryItem({galleryId:"old",path:"C:\\outputs\\old.png",prompt:"旧指令"});
  assert.equal(item.fileName,"old.png");assert.equal(item.kind,"chat");assert.equal(item.size,"auto");
  const original=h.api.galleryArchive;h.api.galleryArchive=async()=>{throw new Error("磁盘不可写");};
  await assert.rejects(h.useGallery.getState().archive(item),/磁盘/);assert.equal(h.useGallery.getState().items.length,0);assert.equal(h.useGallery.getState().archiving.length,0);
  h.api.galleryArchive=original;await h.useGallery.getState().archive(item);assert.equal(h.useGallery.getState().items.length,1);
});

test("数字草稿清空不改成最小值，提交时才恢复或限制范围", () => {
  assert.equal(numberInput.commitNumberDraft("", 6, 0, 20), 6);
  assert.equal(numberInput.commitNumberDraft("  ", 6, 0, 20), 6);
  assert.equal(numberInput.commitNumberDraft("12", 6, 0, 20), 12);
  assert.equal(numberInput.commitNumberDraft("0", 6, 0, 20), 0);
  assert.equal(numberInput.commitNumberDraft("99", 6, 0, 20), 20);
  assert.equal(numberInput.commitNumberDraft("-2", 6, 0, 20), 0);
  assert.equal(numberInput.commitNumberDraft("3.9", 6, 0, 20), 3);
  for (const text of ["abc", "NaN", "Infinity"]) assert.equal(numberInput.commitNumberDraft(text, 6, 0, 20), 6);
});

test("预览适应屏幕，锚点缩放与双指平移保持像素位置并限制拖动", () => {
  const bounds = preview.fitPreview(500, 400, 1000, 500);
  assert.equal(bounds.imageWidth, 476); assert.equal(bounds.imageHeight, 238);
  assert.equal(preview.fitPreview(500, 400, 100, 80).imageWidth, 100);
  assert.equal(preview.fitPreview(0, 0, 100, 80).imageWidth, 0);
  const full = { width: 500, height: 400, imageWidth: 476, imageHeight: 376 };
  assert.deepEqual(preview.zoomPreview(preview.FIT_PREVIEW, 2, { x: 100, y: 40 }, full), { scale: 2, x: -100, y: -40 });
  assert.deepEqual(preview.zoomPreview(preview.FIT_PREVIEW, 2, { x: 100, y: 40 }, full, { x: 130, y: 60 }), { scale: 2, x: -70, y: -20 });
  assert.equal(preview.clampPreview({ scale: 0.5, x: 9999, y: -9999 }, full).scale, 1);
  assert.equal(preview.clampPreview({ scale: 99, x: 9999, y: 9999 }, full).scale, 8);
  assert.deepEqual(preview.zoomPreview({ scale: 3, x: 50, y: 20 }, 1, { x: 0, y: 0 }, full), { scale: 1, x: 0, y: 0 });
});

async function runPixelCode(code, inputs = [{ width: 2, height: 2, data: new Uint8ClampedArray([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]) }]) {
  const results = [];
  const context = vm.createContext({ Uint8ClampedArray, performance: { now: () => 0 }, postMessage: (result) => results.push(result) });
  vm.runInContext(codeWorkerSource.replace("/*__CHAT_CODE__*/", () => code), context, { timeout: 1000 });
  await context.onmessage({ data: { id: "pixels", images: inputs } });
  assert.equal(results.length, 1); return results[0];
}
const imageBytes = (result, index = 0) => Array.from(result.images[index].data);

test("内置 JS 克隆和填色不修改输入，裁剪支持边界外透明像素", async () => {
  const source = { width: 2, height: 1, data: new Uint8ClampedArray([255,0,0,255,0,255,0,255]) };
  const result = await runPixelCode("const out=image.clone(images[0]);image.fill(out,[0,0,255,128],1,0,1,1);return image.crop(out,-1,0,3,1);", [source]);
  assert.equal(result.type, "result");
  assert.deepEqual(Array.from(source.data), [255,0,0,255,0,255,0,255]);
  assert.deepEqual(imageBytes(result), [0,0,0,0,255,0,0,255,0,0,255,128]);
});

test("内置 JS 翻转、旋转和逐像素调色使用准确坐标", async () => {
  const result = await runPixelCode("return [image.flip(images[0]),image.rotate(images[0]),image.rotate(images[0],-1),image.map(images[0],(r,g,b,a,x,y)=>[x*255,y*255,0,a])];");
  assert.equal(result.type, "result");
  assert.deepEqual(imageBytes(result), [0,255,0,255,255,0,0,255,255,255,255,255,0,0,255,255]);
  assert.deepEqual(imageBytes(result, 1), [0,0,255,255,255,0,0,255,255,255,255,255,0,255,0,255]);
  assert.deepEqual(imageBytes(result, 2), [0,255,0,255,255,255,255,255,255,0,0,255,0,0,255,255]);
  assert.deepEqual(imageBytes(result, 3), [0,0,0,255,255,0,0,255,0,255,0,255,255,255,0,255]);
});

test("内置 JS 缩放预乘透明度，合成保持正确 alpha", async () => {
  const source = { width: 2, height: 1, data: new Uint8ClampedArray([255,0,0,255,0,0,255,0]) };
  const resized = await runPixelCode("return image.resize(images[0],1,1);", [source]);
  assert.deepEqual(imageBytes(resized), [255,0,0,128]);
  const result = await runPixelCode("const out=image.create(1,1,[0,0,255,255]);return image.composite(out,image.create(1,1,[255,0,0,128]));");
  assert.deepEqual(imageBytes(result), [128,0,127,255]);
  const transparent = await runPixelCode("return image.composite(image.create(1,1),image.create(1,1,[10,20,30,128]));");
  assert.deepEqual(imageBytes(transparent), [10,20,30,128]);
});

test("内置 JS 拒绝非法尺寸、输出数量与像素格式，不支持画布时明确报错", async () => {
  for (const code of ["return image.create(0,2);","return image.create(4097,1);","return image.create(1.5,1);","return [];","return Array(5).fill(images[0]);","return {width:1,height:1,data:[0,0,0,0]};","return image.composite(images[0],images[0],0,0,2);"]) {
    const result = await runPixelCode(code); assert.equal(result.type, "error", code); assert.ok(result.message);
  }
  const canvas = await runPixelCode("return image.canvas(images[0]);");
  assert.equal(canvas.type, "error"); assert.match(canvas.message, /OffscreenCanvas/);
});

test("内置 JS 限制日志且剥离任意输出字段，不暴露网络、存储或应用接口", async () => {
  const result = await runPixelCode("log(typeof fetch,typeof importScripts,typeof Worker,typeof indexedDB,typeof navigator,typeof document,typeof window);log(1n);const circular={};circular.self=circular;log(circular);for(let i=0;i<80;i++)console.log('x'.repeat(700));return {...images[0],secret:'drop'};");
  assert.equal(result.type, "result"); assert.equal(result.logs[0], Array(7).fill("undefined").join(" "));
  assert.equal(result.logs.length, 40); assert.ok(result.logs.every((line) => line.length <= 500));
  assert.deepEqual(Object.keys(result.images[0]).sort(), ["data","height","width"]);
});

test("代码运行时默认关闭，超时配置有效，主窗口重新验证输出", () => {
  assert.deepEqual(codeRuntime.codeRuntimeSettings(), { enabled: false, timeoutSecs: 10 });
  for (const timeoutSecs of [NaN,Infinity,undefined]) assert.equal(codeRuntime.codeRuntimeSettings({ timeoutSecs }).timeoutSecs, 10);
  assert.equal(codeRuntime.codeRuntimeSettings({ timeoutSecs: -3 }).timeoutSecs, 1);
  assert.equal(codeRuntime.codeRuntimeSettings({ timeoutSecs: 90 }).timeoutSecs, 30);
  assert.equal(codeRuntime.codeRuntimeSettings({ enabled: true, timeoutSecs: 3.9 }).timeoutSecs, 3);
  const pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4), arbitrary: "drop" };
  assert.deepEqual(Object.keys(codeRuntime.validateCodeOutputs([pixels])[0]).sort(), ["data","height","width"]);
  for (const value of [[],Array(5).fill(pixels),[null],[{...pixels,width:5000}],[{...pixels,data:new Uint8Array(4)}]]) assert.throws(() => codeRuntime.validateCodeOutputs(value));
});

test("隔离页无同源权限，Worker 继承禁止联网与动态脚本的 CSP", async () => {
  const html = await readFile(new URL("../public/runtime/sandbox.html", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../public/runtime/sandbox.js", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../src/lib/codeRuntime.ts", import.meta.url), "utf8");
  const nativeConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.match(html, /connect-src 'none'/); assert.match(html, /worker-src blob:/);
  assert.match(bootstrap, /script-src 'none'; worker-src blob:; connect-src 'none'/);
  assert.match(runtime, /setAttribute\("sandbox", "allow-scripts"\)/); assert.ok(!runtime.includes("allow-same-origin"));
  for (const policy of [nativeConfig.app.security.csp,nativeConfig.app.security.devCsp]) { assert.match(policy, /frame-src 'self'/); assert.match(policy, /worker-src blob:/); }
});

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
  assert.equal(h.useGallery.getState().items.length, 0, "生成结果只能由用户主动入库");
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
