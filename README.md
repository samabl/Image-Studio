# GPT Image Studio

一个用 **Tauri 2** 构建的跨平台（Windows / Android）AI 图像工作台：**AI 对话 + 文生图 + 图生图 + 图像编辑**，
通过可配置的 **Base URL + API Key** 调用任意 OpenAI 兼容网关，**对话模型与图像模型分别配置、并且可以互相联动**。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [对话 ⇄ 图像 联动的四种玩法](#对话--图像-联动的四种玩法)
- [接口形态：images 与 chat](#接口形态images-与-chat)
- [Windows 打包](#windows-打包)
- [Android 打包](#android-打包)
- [数据与安全](#数据与安全)
- [已知限制](#已知限制)

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 💬 **AI 对话** | 多轮会话、SSE 流式输出、思维链折叠显示、Markdown 渲染（代码块带复制）、随时中断、重新生成、多会话管理 |
| 👁 **多模态输入** | 对话里可以贴图片，让模型看图（vision）；支持粘贴、拖拽、文件选择 |
| 🎨 **文生图** | `/images/generations`，尺寸 / 数量 / 质量 / 背景 / 输出格式可调 |
| 🖼 **图生图** | 上传参考图 + 提示词，走 `/images/edits`，支持多图组合 |
| ✏️ **图像编辑** | 内置**蒙版画笔**，涂抹要改的区域做局部重绘（inpainting），支持撤销 |
| 🔗 **模型联动** | 对话模型可**直接调用图像模型**（function calling）；也能优化提示词、反推图片提示词 |
| 🖼 **图库** | 所有产出自动落盘归档，带提示词/模型/尺寸元信息，支持筛选、批量删除、导出 |
| ⚙️ **双通道独立配置** | 对话与图像可以有完全不同的 Base URL / Key / 模型 |
| 📱 **跨平台** | 同一套代码出 Windows 安装包与 Android APK |

---

## 技术栈

- **外壳**：Tauri 2（Rust + 系统 WebView）
- **前端**：React 19 + TypeScript + Vite 8 + Zustand
- **后端**：Rust + `reqwest`（全部网络请求都在 Rust 侧完成）
- **零重依赖**：Markdown 渲染器自研，不引 `remark`/`unified` 全家桶；不引图表库

> **为什么网络请求放在 Rust 而不是前端 `fetch`？**
> 一是绕开 WebView 的 CORS 限制，二是避免 `http://` 端点被当成混合内容拦截，
> 三是 API Key 不必暴露在页面的 JS 环境里。Android 上同样受益。

---

## 目录结构

```
.
├── index.html
├── vite.config.ts
├── src/                          # 前端
│   ├── App.tsx                   # 外壳：导航 / 顶栏 / 拖拽导入 / 路由
│   ├── styles.css                # 设计系统 + 移动端适配
│   ├── types.ts                  # 与 Rust 结构体一一对应的类型
│   ├── lib/
│   │   ├── api.ts                # invoke 封装（含流式 Channel）
│   │   ├── store.ts              # Zustand 状态 + 对话/工具执行循环
│   │   ├── image.ts              # 缩放、蒙版渲染等 canvas 工具
│   │   ├── shell.ts              # 打开外链/文件夹、剪贴板
│   │   └── platform.ts           # 平台判定
│   └── components/
│       ├── ChatView.tsx          # 对话页
│       ├── StudioView.tsx        # 图像工作室
│       ├── MaskCanvas.tsx        # 蒙版画笔
│       ├── GalleryView.tsx       # 图库
│       ├── SettingsView.tsx      # 设置
│       ├── Markdown.tsx          # 轻量 Markdown 渲染器
│       ├── Overlays.tsx          # Toast / 灯箱
│       └── ui.tsx                # 基础控件
└── src-tauri/                    # 后端
    ├── Cargo.toml
    ├── tauri.conf.json           # 应用配置（含 CSP、asset 协议、Android minSdk）
    ├── capabilities/default.json # 权限声明
    ├── icons/                    # 各平台图标（由 icons/source.png 生成）
    └── src/
        ├── main.rs
        ├── lib.rs                # 所有 #[tauri::command]
        ├── ai.rs                 # OpenAI 兼容协议：对话/流式/文生图/图生图
        ├── config.rs             # 配置读写与默认值
        ├── gallery.rs            # 图库落盘与索引
        └── error.rs              # 统一错误类型
```

---

## 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20.19 | Vite 8 要求 |
| pnpm | ≥ 9 | 也可以用 npm |
| Rust | ≥ 1.77.2 | `rustup` 安装 |
| MSVC 生成工具 | VS 2022 Build Tools | Windows 编译必需（勾选「使用 C++ 的桌面开发」） |
| WebView2 | 系统自带 | Win10/11 一般已预装 |

```bash
# 1. 安装前端依赖
pnpm install

# 2. 开发模式（热重载）
pnpm tauri:dev

# 3. 生产构建（Windows 安装包）
pnpm tauri:build

# 4. 拿真实网关跑一遍协议层联调（可选，见下）
$env:GIS_TEST_BASE = "http://10.0.0.1:3000"; $env:GIS_TEST_KEY = "sk-..."
pnpm test:live
```

产物位置：

- 可执行文件：`src-tauri/target/release/gpt-image-studio.exe`
- 安装包：`src-tauri/target/release/bundle/nsis/*.exe`

### 联调测试

`src-tauri/tests/live_gateway.rs` 会直接打真实端点，覆盖：
Base URL 正规化、SSE 流式对话、`tool_calls` 分片累积、文生图、图生图、蒙版重绘、
以及「网关不支持某参数时自动降级重试」。

未设置 `GIS_TEST_BASE` / `GIS_TEST_KEY` 时联网用例自动跳过，所以 `cargo test` 随手跑也安全。

---

## 配置说明

打开应用 → **设置**，分别配置两个通道。两者完全独立。

### Base URL 的三种写法都支持

| 你填的 | 实际请求的端点 |
| --- | --- |
| `http://10.0.0.1:3000` | `http://10.0.0.1:3000/v1/chat/completions` |
| `http://10.0.0.1:3000/v1` | `http://10.0.0.1:3000/v1/chat/completions` |
| `http://10.0.0.1:3000/v1/chat/completions` | 原样使用 |

> 不必纠结要不要带 `/v1`，三种写法都能正确识别。

### 两个通道

| | 对话模型 | 图像模型 |
| --- | --- | --- |
| 用途 | 聊天、看图、优化提示词、反推提示词、驱动出图 | 文生图 / 图生图 / 局部重绘 |
| 关键字段 | `baseUrl` `apiKey` `model` `systemPrompt` `temperature` `maxTokens` `timeoutSecs` | `baseUrl` `apiKey` `model` `apiMode` `size` `n` `timeoutSecs` |
| 拉取模型 | 「↻ 拉取模型列表」会请求 `/v1/models` 并缓存到本地 | 同左 |

**超时设置很重要**：`gpt-image-2.5` 出图单张可能超过 2 分钟，图像通道默认给到 600 秒。
如果网关前面还有反向代理 / 内网穿透，**代理那一侧的空闲超时必须比这里更宽松**，
否则请求会先被代理掐断、返回像 `502 Bad Gateway ... upstream timeout after 30000ms` 这样的错误体
（App 会把它显示成「接口返回 502」）。

### HTTPS 网关 / 自签证书（TLS 信任）

App 的请求全部走 Rust 侧（`reqwest` + `rustls`），信任库同时含两套：

| 信任来源 | 覆盖什么 | 来源 |
| --- | --- | --- |
| `rustls-tls` | Mozilla 内置根证书 | 编译进 App，公网 CA 全部可用 |
| `rustls-tls-native-roots` | **操作系统信任库** | Windows 证书存储 / macOS 钥匙串 / Linux 的 `SSL_CERT_FILE`、`/etc/ssl/certs` |

所以自签根证书**导入系统信任库**后，App 就能直接走 `https://<内网网关>`：

```powershell
Import-Certificate -FilePath portforward-ca.crt -CertStoreLocation Cert:\LocalMachine\Root
```

> 只装给浏览器/Node 是不够的：浏览器读系统库、Node 要 `NODE_EXTRA_CA_CERTS`，
> 而 App 之前只用 `webpki-roots`（Mozilla 内置根），看不到系统里导入的证书，
> 会直接抛 `InvalidCertificate(UnknownIssuer)`。现在两套都读。

**Android 例外**：`rustls-native-certs` 在 Android 上走的是 Unix 分支，
读不到 `/system/etc/security/cacerts`，等效于「只有公网 CA」。给安卓用请优先选：

- 由穿透 / 隧道服务提供**受信任证书**的入口（如 `https://<隧道域名>:<端口>`），客户端零配置；
- 或让网关提供明文 HTTP 入口，并按「Android 必做：允许明文 HTTP」放行该域名。

自带联调用例可以验证信任是否生效（不花额度，只打 `/v1/models`）：

```powershell
$env:GIS_TEST_BASE = "https://<内网网关>:2233"
$env:GIS_TEST_KEY  = "sk-..."
cargo test --manifest-path src-tauri/Cargo.toml --test live_gateway list_models -- --nocapture
```

---

## 对话 ⇄ 图像 联动的四种玩法

这是本项目的核心设计——两个模型不是各干各的，而是能互相驱动。

### 1️⃣ 对话里直接出图（function calling）

开启 **设置 → 联动 → 允许对话模型直接调用图像工具** 后，
对话请求会自动带上两个工具定义：`generate_image` 与 `edit_image`。

```
你：帮我画一只在雨夜街头的赛博朋克猫
助手：[调用 generate_image] → 图片直接出现在对话里
你：把霓虹灯改成暖橙色
助手：[调用 edit_image，源图=上一张] → 新图片
```

实现要点：
- Rust 侧把流式 `tool_calls` 分片累积成完整调用（`ai.rs`）；
- 前端 `store.ts` 的 `runTurn()` 负责执行工具、把结果作为 `role: "tool"` 消息回灌给模型，
  最多循环 4 轮，防止模型陷入无意义的反复出图。

### 2️⃣ 提示词优化（对话模型 → 图像模型）

在图像工作室点 **✨ AI 优化**：把口语化想法交给对话模型，按
「主体 → 细节 → 动作 → 环境 → 构图 → 光线 → 风格」的结构扩写成专业提示词。

也可以在设置里打开 **出图前自动用对话模型润色提示词**，让这步自动发生。

### 3️⃣ 图片反推提示词（图像模型 → 对话模型）

点 **🔍 反推**：把图片喂给视觉模型，让它反推出一条可直接复用的生图提示词。
图库里每张图也带这个按钮。

### 4️⃣ 跨页接力

- 对话里生成的图片 → **✎ 送去编辑** / **✨ 做变体** → 带着参考图跳到图像工作室；
- 图库里的图片 → **💬 去对话** → 新建会话并把图片作为附件投喂给模型，让它指挥 `edit_image`。

---

## 接口形态：images 与 chat

不同厂商的图像模型暴露方式不一样，所以图像通道提供了两种形态：

| `apiMode` | 端点 | 适用 |
| --- | --- | --- |
| `images`（默认） | `POST /v1/images/generations`（文生图）<br>`POST /v1/images/edits`（图生图 / 蒙版，multipart） | `gpt-image-2`、`gpt-image-2.5` 等 |
| `chat` | `POST /v1/chat/completions` + `modalities: ["image","text"]` | Gemini 系图像模型等 |

响应解析同时兼容三种返回形态，无需手动切换：

1. `data[].b64_json` —— 标准 base64 返回；
2. `data[].url` —— 返回图片链接，Rust 侧自动下载落盘；
3. 图片内嵌在 `choices[].message.content` 的 Markdown 里
   （`![image](data:image/jpeg;base64,...)`，Gemini 系模型常见）。

关于参数兼容性：`quality` / `background` / `output_format` 默认值为 **`auto`，表示不下发该参数**，
以最大化对各家网关的兼容性。需要时在「高级参数」里显式指定即可。

---

## Windows 打包

```bash
pnpm tauri:build
```

- 安装包（NSIS）：`src-tauri/target/release/bundle/nsis/GPT Image Studio_0.1.0_x64-setup.exe`
- 免安装可执行文件：`src-tauri/target/release/gpt-image-studio.exe`（前端已内嵌，双击即用）
- 安装模式为 `currentUser`（免管理员），语言含简体中文
- 若目标机器缺少 WebView2，安装包会走 `downloadBootstrapper` 自动下载
- 想同时产出 MSI，把 `tauri.conf.json` 里的 `bundle.targets` 改成 `"all"`（首次会下载 WiX）

> **首次打包需要能访问 GitHub。** NSIS / WiX 打包工具是 Tauri 在首次打包时从
> `github.com/tauri-apps/binary-releases` 下载的（缓存到 `%LOCALAPPDATA%\tauri`）。
> 如果网络访问不了 GitHub，`pnpm tauri:build` 会在**最后一步**报
> `failed to bundle project: ...`，但此时 `gpt-image-studio.exe` 已经编译完成并可正常使用，
> 只是没有安装包外壳。想拿到安装包，在能访问 GitHub 的网络下重跑即可。

> ⚠️ **不要用 `cargo build --release` 代替。** 直接 `cargo build --release` 编出来的二进制
> 会指向 `devUrl`（启动后显示「localhost 拒绝连接」），因为 tauri-build 判断是否处于 dev 模式
> 依赖 Tauri CLI 注入的 `TAURI_ENV_*` 环境变量。请始终使用 `pnpm tauri:build` / `pnpm tauri:dev`。

只想快速验证功能，用开发模式即可：`pnpm tauri:dev`

---

## Android 打包

Android 需要额外安装工具链（本仓库不包含它们，也无法预置）：

| 依赖 | 建议版本 |
| --- | --- |
| JDK | 17（Tauri 2 要求 17） |
| Android SDK | Platform 34+、Build-Tools 34+ |
| Android NDK | 26.x |
| Rust targets | `aarch64-linux-android`、`armv7-linux-androideabi`、`i686-linux-android`、`x86_64-linux-android` |

```bash
# 1) 环境变量（Windows PowerShell 示例）
$env:JAVA_HOME          = "C:\Program Files\Eclipse Adoptium\jdk-17"
$env:ANDROID_HOME       = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME           = "$env:ANDROID_HOME\ndk\26.1.10909125"

# 2) 一条命令搞定：补 Rust 目标 + init 工程 + 注入明文流量配置
pnpm android:setup
# 也可以指定要放行的内网网关（比全局放开安全得多）
# pnpm android:setup -- -CleartextHosts 10.213.196.114,192.168.1.10

# 3) 打包 APK / AAB
pnpm android:apk                    # 产出 APK（未签名）
# 签名（必做，否则装不上）：
pwsh -File scripts/sign-android-apk.ps1 -KeystorePath <jks> -KeyAlias <alias> -KeyPassword <pwd>
pnpm tauri android build --ci       # 产出 AAB（上架 Google Play 用）

# 4) 真机调试
pnpm android:dev
```

`scripts/setup-android.ps1` 会自动完成四件事：

1. 校验 `JAVA_HOME` / `ANDROID_HOME` / `NDK_HOME`，缺什么就给出具体的安装命令；
2. 补齐四个 Rust 交叉编译目标（`aarch64` / `armv7` / `i686` / `x86_64-linux-android`）；
3. 调用 `pnpm tauri android init` 生成 `src-tauri/gen/android/`；
4. 生成 `network_security_config.xml` 并注入 `AndroidManifest.xml`
   —— **内网 `http://` 网关在 Android 9+ 上默认被拦截，这一步是必须的**。

脚本可重复执行，已打过的补丁不会重复写入。

### ⚠️ Android 必做：允许明文 HTTP

如果你的 Base URL 是 `http://...`（内网网关多数如此），必须放行明文流量。
`pnpm android:setup` 已经替你做了。手工等价做法是：

在 `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 的 `<application>` 上引用：

```xml
<application
    android:networkSecurityConfig="@xml/network_security_config"
    ... >
```

并新建 `src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml`：

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">10.213.196.114</domain>
        <domain includeSubdomains="true">localhost</domain>
    </domain-config>
</network-security-config>
```

然后在 `<application>` 上引用：

```xml
android:networkSecurityConfig="@xml/network_security_config"
```

> 补充说明：应用内所有 AI 请求都由 Rust 侧的 `reqwest` 直接发起，不经 WebView。
> AOSP 的明文限制主要作用于 Java 网络栈，所以多数设备上即使不开也能通；
> 但部分厂商 ROM / MDM 策略会更严格，加上这行最省事。

### 其他 Android 说明

- 权限：`INTERNET`（Tauri 自动加上）。
- 文件选择：用的是标准 `<input type="file">`，Android 上会拉起系统相册/文件选择器；
  桌面端则是原生文件对话框。两端行为一致，不需要额外插件。
- 触屏：导航会自动变成底部标签栏；蒙版画笔用 Pointer Events，手指可直接涂抹。
- `minSdkVersion` 在 `tauri.conf.json` 里配置，当前为 **24**（Android 7.0）。

---

## CI/CD（GitHub Actions）

`.github/workflows/build.yml` 在**推送到 main、打 tag、或手动触发**时自动构建，
Windows 与 Android 并行产出可下载的构建产物。

| Job | Runner | 产物 | 说明 |
| --- | --- | --- | --- |
| `windows` | `windows-latest` | `gpt-image-studio.exe` + NSIS 安装包 | 先跑 `pnpm typecheck` 再 `pnpm tauri:build` |
| `android` | `ubuntu-latest` × 3 | 每个 ABI 一个 APK | 矩阵并行：`arm64-v8a` / `armeabi-v7a` / `x86_64` |

产物在 Actions 运行页面的 **Artifacts** 区域下载，保留 14 天。

### 缓存策略

| 缓存 | 手段 | Key |
| --- | --- | --- |
| pnpm 依赖 | `actions/setup-node` 的 `cache: pnpm` | lockfile 哈希 |
| Rust 依赖 + 编译产物 | `Swatinem/rust-cache@v2` | `Cargo.lock` + job key，Windows 与各 ABI 各一份互不干扰 |
| Gradle 缓存与 wrapper | `actions/cache@v4` | `tauri.conf.json` 哈希 |

Rust 的 `target` 目录缓存是加速的关键：首次构建约 15–20 分钟，命中缓存后通常 3–5 分钟。
设置了 `CARGO_BUILD_JOBS=3` 抑制 LTO 阶段的峰值内存（runner 只有 7GB 内存，并行过猛会被 OOM 杀掉）。

### 踩坑记录

这几条都是实际跑 CI 踩出来的，写下来免得重复掉坑：

1. **`android-actions/setup-android@v3` 在 ubuntu-24.04 上会挂。**
   它尝试安装上游已移除的旧版 `tools` 包，`sdkmanager` 以退出码 1 结束并打断整个 job。
   GitHub 的 ubuntu 镜像本来就预装了完整 SDK（`/usr/local/lib/android/sdk`），
   所以改成「探测预装 SDK + 按需补 NDK + 导出环境变量」。

2. **`tauri android init` / `build` 在非交互环境必须传 `--ci`。**
   不传会一直等着输入而卡死；`init` 会自动读 `CI` 环境变量，但 `build` 不会，必须显式传。

3. **不要用正则去改 Tauri 生成的 `app/build.gradle.kts`。**
   模板用的是 Kotlin DSL 的 `getByName("release") { ... }`，版本之间还会变。
   实测出现过「匹配不到 release 块 → 静默产出未签名 APK」而构建日志一路全绿的情况。

4. **写 XML 时注意两件事**：PowerShell 单引号字符串不做转义（`'$1`n'` 会把
   「反引号 + n」写进 XML，导致 Gradle 的 `ManifestMerger` 解析失败）；
   以及别用 `Set-Content -Encoding UTF8`（Windows PowerShell 5.1 下会写 BOM，同样解析失败）。

5. **APK 产出的目录是 `app/build/outputs/apk/universal/release/`**，
   文件名里带 `universal`，即使只构建单个 ABI 也是这个名字。

### Android 签名

Tauri 生成的 Gradle 模板**没有配 `signingConfig`**，所以 `tauri android build --apk`
产出的 `app-universal-release-unsigned.apk` 是未签名的，**无法直接安装**。

本项目用 **`apksigner` 后置签名**解决，而不是去改 `app/build.gradle.kts`：

```bash
pnpm tauri android build --apk --ci
pwsh -File scripts/sign-android-apk.ps1 \
  -KeystorePath ./upload-keystore.jks -KeyAlias upload -KeyPassword <你的密码>
```

脚本会依次做 zipalign → apksigner sign → apksigner verify，**校验通过才删掉未签名原件**。

> 为什么不改 Gradle 模板？Tauri 用的是 `getByName("release") { ... }` 这类 Kotlin DSL，
> 版本之间还会变，靠正则匹配非常脆。实测就出现过「匹配不到 release 块 → 静默产出未签名 APK」
> 的情况，而构建日志一路全绿。apksigner 只依赖 Android SDK 自带的稳定命令行工具。

CI 默认**生成一次性 keystore** 并签好 APK，保证产物开箱即可安装。
但它每次构建都会换一把新密钥，因此**无法覆盖安装**上一次构建的版本。

需要稳定签名（能覆盖升级、能上架）时，在仓库 **Settings → Secrets and variables → Actions**
里配置三个 secret，三者必须同时配置：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEY_BASE64` | keystore 的 base64：`base64 -i upload-keystore.jks \| tr -d '\n'` |
| `ANDROID_KEY_ALIAS` | `keytool` 里的 alias |
| `ANDROID_KEY_PASSWORD` | keystore 密码 |

> 注意：`.github/workflows/*` 属于受保护路径。用**经典 PAT** 推送时，
> token 必须勾选 `workflow` scope，否则 push 会被 GitHub 拒绝（仅 `repo` 不够）。

---

## 数据与安全

所有数据都在本机应用数据目录：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\com.gptimagestudio.desktop\` |
| Android | `/data/data/com.gptimagestudio.desktop/files/` |

```
config.json            # 两个通道的配置（含 API Key）
state/sessions.json    # 对话历史
gallery/index.json     # 图库索引
gallery/images/*.png   # 原图
```

设置页底部会直接把真实路径显示出来，并提供「打开目录」。

**⚠️ 安全须知**

- **API Key 以明文存放**在 `config.json` 中（这也是绝大多数同类桌面工具的做法）。
  请勿把该文件提交到版本库或分享给他人；`.gitignore` 已排除常见密钥文件名，但 `config.json` 本身
  位于系统目录、不在仓库内。
- 渲染模型输出时**全程使用 React 节点，不使用 `dangerouslySetInnerHTML`**，
  模型返回的 HTML/脚本不会被执行。
- CSP 限制为 `default-src 'self'`，外链一律交给系统浏览器打开。
- 只有同源网关返回的图片 URL 才会带上 `Authorization` 头下载，避免密钥泄漏给第三方图床。

---

## 验证状态

### 本机实测（Windows 11 + Rust 1.98 + Node 24）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 协议层：Base URL 正规化 / data URL 解析 | 单元测试（不联网） | ✅ 通过 |
| 协议层：模型列表、非流式对话、SSE 流式对话 | `tests/live_gateway.rs` 打真实网关 | ✅ 通过 |
| 协议层：`tool_calls` 流式分片累积 | 真实模型返回，断言参数是合法 JSON | ✅ 通过 |
| 协议层：文生图 → 图生图 → 蒙版局部重绘 | 真实网关全链路 | ✅ 通过 |
| 兼容性：网关拒绝 `temperature` 时自动降级 | 故意发不支持参数，断言仍成功 | ✅ 通过 |
| 应用：启动、配置读写、UI 渲染 | 运行 debug 构建并截图核对 | ✅ 通过 |
| **联动**：对话模型自主调用出图 → 图片内联 → 基于结果继续回话 | 在真实 UI 里点击触发，走完整 Agent 闭环 | ✅ 通过 |
| 应用：图库落盘 + asset 协议加载历史图 | 生成后切到图库页核对缩略图 | ✅ 通过 |
| 应用：图像工作室（文生图 / 图生图 / 蒙版 UI） | 运行并截图核对 | ✅ 通过 |
| Windows 打包（release 可执行文件） | `pnpm tauri:build` | ✅ 通过 |

### CI 实测（GitHub Actions，ubuntu-24.04 / windows-latest）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| Windows 构建 + NSIS 安装包 | `windows` job | ✅ 通过（产物 4.29 MB） |
| Android 三个 ABI 构建 | `android` 矩阵 job | ✅ 通过（arm64-v8a / armeabi-v7a / x86_64） |
| APK 签名 | 下载产物用 `apksigner verify` 复验 | ✅ 通过（v2 + v3，本地复验 APK Signing Block 存在） |
| 明文流量配置进入包内 | 解包检查二进制 `AndroidManifest.xml` 字符串池 | ✅ 通过（含 `networkSecurityConfig`） |
| AndroidManifest 补丁逻辑 | `scripts/test-android-manifest.ps1` | ✅ 13/13 |
| 缓存建立 | Actions Caches API | ✅ 7 条 / 2.19 GB |

**尚未验证**：Android 真机/模拟器运行。环境里没有设备，
所以「APK 能装、能跑、能连上网关」这三件事只到「构建产物结构正确且已签名」为止。

如果想在本机复现整套 Android 流程，见 [Android 打包](#android-打包)；
`pnpm android:setup` + `pnpm android:apk` + `pnpm android:sign` 三步。

Android 侧已按 Tauri 2 规范完成全部工程级配置（`tauri.conf.json` 的 `bundle.android`、
图标集、权限声明、`INTERNET` 权限、明文流量脚本），CI 上也能稳定产出**已签名的可安装 APK**，
但**没有在真机/模拟器上跑过**（环境里没有设备）。

---

## 已知限制

- **Android 端不支持「导出到…」**：系统保存对话框在移动端行为不一致，图片目前保存在应用私有目录内。
  后续可通过 MediaStore 或系统分享面板补齐。
- **对话历史的图片**：以 data URL 形式存在 `sessions.json` 里，长期大量贴图会让该文件变大。
  生成的图片会同时归档到图库（存的是文件路径），可以随时清理历史会话。
- **`apiMode = chat` 不支持 `n > 1`**：该形态由对话模型决定出图数量。
- 多图组合（一次传多张参考图）依赖网关支持 `image[]` 字段，部分网关只接受单张。
