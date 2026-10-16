# DogSC for Windows

Windows 移植版 [DogSC](https://github.com/laogou717/dogsc) —— 屏幕录制与轻量剪辑工具。

录制、剪辑、运镜，到导出成片。功能、界面布局、交互方式与使用体验对齐 macOS 原版。

**English** — Unofficial Windows port of [DogSC](https://github.com/laogou717/dogsc), the macOS screen recorder with lightweight editing: screen / window / area recording, zoom and camera moves, cursor effects, 3D screen motion, backgrounds, mockups, and export. Features, layout and feel follow the original. This is a development build — usable, but not guaranteed stable, and not an official release of the original author. No prebuilt binaries; run it from source (see below).

> ## ⚠️ 开发版提示（请先阅读）
>
> - 这是一个正在持续开发中的移植版本，**功能可用但不保证稳定**，可能仍有未发现的 bug（导出、录制、光标等模块都在近期修复过多轮）。
> - 本仓库**不是原作者的官方发布**，使用中遇到的问题请在本仓库提 Issue，不要提到原仓库。
> - 未提供预编译安装包，请按下方说明从源码运行；自行打包的产物同样属于开发版。
> - 欢迎试用与反馈，但请勿用于重要的商业录制场景。

---

## 怎么打开

**最简单：双击 `启动 DogSC.bat`。**

项目根目录有三个启动脚本（双击即可；后两个只是转发到主脚本，启动逻辑只维护一份）：

| 脚本 | 用途 |
| --- | --- |
| `启动 DogSC.bat` | 常规启动 |
| `启动 DogSC（软件渲染）.bat` | 显卡驱动异常（窗口一闪即退、报错提到 GPU）时改用软件渲染 |
| `DogSC.bat` | 主脚本；也支持带项目路径直接打开：`DogSC.bat "D:\path\xxx.dogscproject"` |

启动方式自动选择：依赖已装好就从源码启动（永远是最新代码）；没装依赖会先自动 `npm install`；只有打包版、没有源码依赖时启动打包版。

首次双击会自动安装依赖（约 1–2 分钟，需要联网），之后每次双击直接启动。

> 批处理脚本依赖 CRLF 行尾（cmd 读取 UTF-8 批处理时，LF 会让中文被错误解码、报「不是内部或外部命令」）。本仓库已用 `.gitattributes` 强制 `*.bat` 为 CRLF；如果从 Zip 解压或手工改过行尾后出现报错，重新 `git checkout` 一下即可恢复。

### 或者用命令行

```bash
npm install       # 只第一次需要
npm start         # 启动
```

### 想要一个能装到开始菜单的正式程序

```bash
npm run dist
```

完成后在 `dist/` 里会得到 `DogSC Setup 0.1.2.exe`，双击安装即可；
`dist/win-unpacked/DogSC.exe` 是可以直接运行的免安装版本。

### 打开时闪一下就退？

说明显卡驱动异常导致 Chromium 的 GPU 进程起不来。改用软件渲染：

```bash
npm start -- --disable-gpu
```

---

## 开发

需要 **Node.js 18+**（本仓库在 Node 22 上开发）。

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动 |
| `npm run dev` | 启动并输出渲染层日志 |
| `npm run dist` | 打包 Windows 安装程序 |
| `npm run demo` | 用 ffmpeg 合成一个演示项目（`demo/`） |
| `npm run icon` | 从原版图标重新生成 `resources/icon.ico` |

---

## 与 macOS 原版的对应关系

移植按原版模块逐一对应，命名与职责保持一致，便于后续跟进上游改动。

| macOS 原版 | 本移植版 |
| --- | --- |
| `AppModel` / `RecorderPanelController` | `src/main/main.js` + `src/renderer/recorder/` |
| `NativeScreenRecording` / `ScreenRecorder` / `CameraRecorder` / `MicrophoneRecorder` | `src/renderer/capture/capture.js`（隐藏的采集窗口） |
| `PointerEventRecorder`（NSEvent 全局监听） | `src/main/input-hook.js` + `resources/pointer-observer.ps1`（`WH_MOUSE_LL` 底层钩子） |
| `ProjectStore` / `ProjectModel` | `src/main/project.js` + `src/renderer/editor/js/model.js` |
| `EditorStore` / `EditorMediaSession` | `src/renderer/editor/js/store.js` |
| `SharedFrameRenderer` | `src/renderer/editor/js/frame-renderer.js` |
| `EditorTimelineView` / `EditorTimelineInteraction` | `src/renderer/editor/js/timeline.js` |
| `EditorInspectorView` 及各工具面板 | `src/renderer/editor/js/inspector.js` |
| `DirectExportPipeline` / `VideoExporter` | `src/renderer/export/export.js` + `src/main/exporter.js` |
| `AppSettingsView` / `AppSettingsWindowController` | `src/renderer/settings/` |
| `FirstLaunchIntroduction` / `FirstUseTour` | `src/renderer/onboarding/` |
| `RecorderMemo` | `src/renderer/memo/` |
| `CaptureAreaSelection` | `src/renderer/area-selector/` |
| `RecordingCompletionWindow` | `src/renderer/completion/` |
| `EditorDesignTokens` | `src/renderer/shared/tokens.css` |
| `Localizable.strings` | `src/renderer/shared/i18n.js` |

### 界面还原

- 配色、圆角、间距、字号逐值取自 `EditorDesignTokens.swift`（NSColor 数值换算为 sRGB）。
- 随包内置原版的 Alibaba PuHuiTi 3 字体，排版与原版一致。
- 录制悬浮条、编辑器工作区、检查器、多轨时间线、导出面板的布局与控件形态按原版截图复刻。
- 深浅色外观、点阵工作区背景、悬浮面板阴影等细节一致。
- macOS 的 `⌘` / `⌥` / `⇧` 快捷键对应到 Windows 的 `Ctrl` / `Alt` / `Shift`。

---

## 功能

### 录制

- 屏幕、窗口、区域、设备四种来源；区域录制由全屏框选浮层确定范围。
- 麦克风、摄像头、系统声音可独立开关，各自录成独立轨道——这是后续能在编辑器里单独调整摄像头布局、光标效果与音量的前提。
- 内置悬浮备忘录，可独立拖动、缩放、调字号与背景不透明度，文稿自动保存且不进入录制画面。
- 录制中可标记（`Ctrl+Alt+M` 全局快捷键或按钮），标记随项目保存、不进成片。
- 录制画面中隐藏桌面图标（可选项）。

### 编辑

- **画面**：背景（网格 / 动态 / 自定图片与视频）、留白与边距、位置与大小、裁切、内容圆角、外描边（十六进制取色）、阴影、背景模糊。
- **样机**：无边框、macOS 窗口浅/深色、浏览器浅/深色、平板样机，可调框体比例、顶栏高度、外圆角、窗口标题与浏览器地址。
- **开场**：聚拢 / 侧滑 / 轻 3D 三种方式，总时长、元素间隔、节奏曲线、参与元素与顺序。
- **运镜**：缩放（自动跟随录制鼠标 / 手动定位）与屏幕 3D（位置、大小、3D 倾斜、平面旋转、透视、圆角），带进入/退出过渡与缓动；新动画默认值可全局设定；光标与屏幕的平滑弹簧参数可调。
- **光标**：系统箭头 / 指向手势 / 十字准星 / 触控圆点 / 始终隐藏，大小、静止后隐藏与延迟、点击反馈（涟漪扩散 / 柔和光晕 / 弹性双环 / 聚焦微闪）、颜色、不透明度与范围；**音画同步**可按 1/30 秒微调光标轨相对画面的偏移。
- **摄像头**：形状、位置预设、大小、圆角、描边、阴影、镜像、缩放联动、蒙版内取景。
- **贴图**：位置、大小、旋转、透明度、描边与颜色、阴影、入场/出场动画与时长、层级顺序（置底/下移/上移/置顶）。
- **打码与柔化**：柔化或突出两种方式、强度、区域位置与大小。
- **声音**：系统声音与麦克风的音量与静音，可按片段覆盖全片设置；片段播放速度 0.25×–4×。
- **时间线**：主片段轨道（分割、裁切、删除、还原剪切、多选）、缩放轨、屏幕 3D 轨、贴图轨、摄像运动轨、打码轨、系统声音轨、麦克风轨；吸附、悬浮预览、恢复剪辑模式、标记列表；缩略图胶片与音频波形。
- **打开已有项目**：录制条右侧的「打开项目」按钮列出项目位置下的最近项目，或通过文件夹选择器浏览任意位置。项目包是文件夹，所以用文件夹选择器，选中包内文件也能正确识别。原版通过菜单栏的「打开项目…」进入，移植版的录制条是唯一常驻界面，入口放在这里。
- **效果复用**：缩放、屏幕 3D、摄像运动、贴图与打码片段可用 `Ctrl+C` / `Ctrl+V` 复制粘贴完整副本，粘贴位置优先取鼠标所指的时间线位置，鼠标离开时间线则用播放头；`Ctrl+Shift+V` 向选中的同类组件粘贴属性，保留其位置与时长。同轨道已有内容或片尾空间不足时会给出对应提示。
- **场景预设**：保存整套画面、摄像头、光标、开场与动画配置并复用，可指定为新录制的默认场景——被指定的预设会在录制完成、编辑器打开之前就写进新项目，所以下次录制直接就是你惯用的样子。预设存在偏好设置里，跨项目可用。
- **摄像头布局预设**：把当前摄像头的形状、位置、大小、描边、阴影、镜像与取景存成命名预设，一键复用。

### 导出

- MP4 视频与 M4A 音频；原始素材 / 1080p / 1440p / 4K 分辨率，30 / 60 FPS。
- **导出选区**：选中一个或多个主片段后按 `Alt+X`，只导出所选范围，面板会显示片段数与起止时间。
- 导出时显示处理阶段、已用时与预计剩余时间，可随时取消。
- 保留 `.dogscproject` 项目包，方便回来继续编辑。

---

## 技术实现

### 渲染管线

预览与导出共用同一个合成器 `frame-renderer.js`，因此两者不会出现差异。绘制顺序与原版一致：

```
背景 → 屏幕（裁切、缩放、位置、3D、圆角、描边、阴影）
     → 样机外框 → 柔化/打码 → 摄像头 → 贴图 → 光标 → 开场动效
```

屏幕 3D 的透视变换用横向条带仿射逼近（canvas 2D 无投影变换），与原版在缺少投影采样器时的降级路径相同。

### 录制管线

**屏幕采集有两条路径，自动择一：**

- **ffmpeg ddagrab（首选，显示器与区域录制）**：Desktop Duplication 恒定帧率采集、不录系统光标，硬件 H.264 直录（NVENC → Media Foundation → AMF → x264 逐个实测择优），录制中写裸流、停止后重封装 MP4。第一帧的系统时钟作为全项目时间原点：指针轨重定基、系统声音 / 麦克风 / 摄像头按各自的启动时刻写入 `offset` 偏移，导出时自动补偿对齐。
- **Chromium 采集（窗口、设备来源，以及 ddagrab 不可用时的自动回退）**：隐藏窗口中的 `MediaRecorder` 按 1 秒分片持续把编码结果写入主进程，长时间录制不占内存。此路径保持原行为（无偏移字段）。

启动时会做 ddagrab 能力实测（滤镜存在 + 主输出真实抓帧），远程会话、虚拟显示或部分混合显卡机器上会自动走 Chromium 路径，录制功能不受影响。

录制完成后会用 `ffmpeg -c copy` 重封装——`MediaRecorder` 不会回填时长，重封装后文件才是完整的。

### 导出管线

三段 ffmpeg，每段都可独立重试：

1. **音频**：按时间线裁切、拼接系统声音与麦克风并混音成 WAV；
2. **视频**：渲染层用 WebCodecs 逐帧编码 H.264（Annex B），ffmpeg 直接封装，不重编码；
3. **合流**：把视频与音频合成为 MP4。

若 WebCodecs 无法提供 H.264 编码器，自动降级为 JPEG 帧序列 + ffmpeg 编码，保证导出始终可用。

### 项目文件

`.dogscproject` 是文件夹包，与原版一致：

```
MyCapture.dogscproject/
  project.json      # 文档（schema v27 兼容）
  media/            # screen / camera / system / microphone / poster / 背景 / 贴图
```

`project.json` 的字段名、枚举取值、默认值与取值范围对齐 `RecorderCore`，两端描述同一次剪辑。

---

## 诊断模式

均为环境变量开启，不影响正常使用。

| 变量 | 作用 |
| --- | --- |
| `DOGSC_SOFTWARE_RENDER=1` | 关闭硬件加速（显卡驱动异常时使用） |
| `DOGSC_USE_PACKAGED=1` | 启动脚本强制优先拉起打包版（`dist/`） |
| `DOGSC_NOSTART=1` | 启动脚本只做解析自检、不真正启动应用（开发用） |
| `DOGSC_LEGACY_RECORD=1` | 强制使用旧的 Chromium 采集路径（诊断用） |
| `DOGSC_DDAGRAB_LAB=1` | 运行 ffmpeg ddagrab 采集链路的分级诊断并输出完整 stderr |
| `DOGSC_FAKE_MEDIA=1` | 让 Chromium 暴露一个虚拟摄像头，便于在没有摄像头的机器上验证设备录制 |
| `DOGSC_SMOKE=<目录>` | 依次打开全部窗口并截图到该目录，然后退出 |
| `DOGSC_RECORD_TEST=1` | 在诊断模式中真实录制 6 秒主显示器并校验产物 |
| `DOGSC_AREA_TEST=1` | 真实录制一块屏幕区域，并校验裁切尺寸与缩放换算 |
| `DOGSC_DEVICE_TEST=1` | 真实录制一个采集设备并校验产物（配合 `DOGSC_FAKE_MEDIA=1` 使用） |
| `DOGSC_WINDOW_TEST=1` | 另起一个进程开动画窗口，验证窗口采集能否投递画面 |
| `DOGSC_OPEN_TEST=1` | 校验录制条上的「打开项目」入口与最近项目列表 |
| `DOGSC_DISCARD_TEST=1` | 校验「移到废纸篓」在多个位置的行为，以及非法路径是否干净拒绝 |
| `DOGSC_RENDER_TEST=1` | 在时间线多点采样合成器输出，校验画面确实在动且不为空 |
| `DOGSC_EDIT_TEST=1` | 校验复制/粘贴、粘贴属性、选区范围、片段速度、摄像头布局预设与撤销 |
| `DOGSC_EXPORT_TEST=1` | 在诊断模式中真实导出一段 MP4 并用 ffmpeg 校验 |

一次性跑完整套回归：

```bash
DOGSC_FAKE_MEDIA=1 DOGSC_DEVICE_TEST=1 DOGSC_AREA_TEST=1 DOGSC_RECORD_TEST=1 \
DOGSC_EDIT_TEST=1 DOGSC_EXPORT_TEST=1 DOGSC_SOFTWARE_RENDER=1 \
DOGSC_SMOKE=./shots npx electron .
```

演示项目可随时重建：

```bash
npm run demo
```

指针钩子可单独验证：

```bash
node tools/probe-pointer.js
```

> 在没有可用显卡驱动、或 Chromium 视频采集服务无法启动的环境（无头服务器、
> 部分虚拟机与沙箱）中，Electron 的渲染进程会被系统直接终止，表现为窗口一闪
> 即退。这不是移植代码的问题——该环境下 `desktopCapturer` 与媒体栈本身不可用。
> 请在有正常显卡驱动的 Windows 桌面上运行。

---

## 已知限制

- **窗口录制**：Chromium 通过 Windows Graphics Capture 采集单个窗口，**需要可用的 GPU**。禁用硬件加速时（`--disable-gpu`）采集器会报告显示器尺寸而非窗口尺寸，并且一帧都不投递——本仓库的 `DOGSC_WINDOW_TEST` 在此环境下会如实标记为跳过。此外，窗口最小化或被完全遮挡时同样收不到画面。以上情况都会明确提示「录制期间没有收到任何画面」，而不是给你一个空项目。
- **屏幕采集（ffmpeg 路径）**：远程桌面会话、虚拟显示或部分混合显卡的机器上 Desktop Duplication（ddagrab）不可用——启动时会实测，不可用时自动回退 Chromium 采集，功能与旧版本一致。
- **`悬浮球` 一类的分层/透明悬浮窗**无法被采集，会返回 `NotReadableError`。选择窗口时请避开这类窗口。
- **设备录制**在 Windows 上没有 ScreenCaptureKit 的对应能力，实现为「直接采集所选设备作为主画面」。此时不记录桌面光标轨，也不生成额外的画中画轨——因为画面本身不是桌面，桌面坐标映射过去没有意义。
- 本机无摄像头时可加 `DOGSC_FAKE_MEDIA=1` 用虚拟设备验证这条路径。
- **无音频设备的机器**：波形分析改用 `OfflineAudioContext`，不碰音频设备，因此不会因为机器没有声卡而失败，编辑时也不会发出任何声音。
- **移到废纸篓**：Windows 的回收站对某些位置不可用（临时目录、部分应用数据目录）。这种情况会明确提示原因，项目**不会**被永久删除。另外系统偶尔会在操作已经成功之后仍报错，这时以文件系统的实际状态为准，避免出现「提示失败但项目其实已经进回收站」。

## 与 macOS 原版的差异

- **权限**：macOS 需要「屏幕录制」「辅助功能」两项系统授权；Windows 无对应机制，改用底层鼠标钩子记录指针，设置页中的权限项指向 Windows 隐私设置。
- **隐藏 Dock**：Windows 无对应概念，仅保留「隐藏桌面文件」。
- **软件更新**：原版通过 Sparkle 连接 GitHub Release；移植版保留检查入口，未接入自动替换。
- **`⌃⌥M` 标记快捷键**：Windows 上注册为全局快捷键，与录制条上的标记按钮等价。

## 打包注意事项

有两个文件必须放在 `app.asar` **之外**，否则只会在打包后才暴露问题：

- `ffmpeg.exe`：asar 内的文件无法被 `spawn`（而 Electron 的 `fs` 会报告它存在），导出时会报裸 ENOENT。已通过 `extraResources` 放到 `resources/ffmpeg/`。
- `pointer-observer.ps1` / `desktop-icons.ps1`：外部进程读不到 asar 里的文件，指针钩子与桌面图标开关会失效。已放到 `resources/scripts/`。

两者的路径解析都在 `src/main/paths.js` 与 `exporter.js` 里优先查 `process.resourcesPath`，并跳过任何含 `app.asar` 的候选。

HTML、CSS、字体与 ES 模块可以留在 asar 内——它们经 `app://` 协议与 `net.fetch` 提供，Electron 对此是 asar 感知的。

改动打包配置后请务必实际运行 `dist/win-unpacked/DogSC.exe` 验证，开发模式不会暴露上述问题。

---

## 致谢与引用

本移植建立在以下开源成果之上，特此致谢：

- **DogSC 原版（macOS）**：由 **神烦老狗（[@laogou717](https://github.com/laogou717)）** 设计、开发并以 MIT License 开源 —— <https://github.com/laogou717/dogsc>。
  本移植的产品设计、界面布局、交互方式与核心算法（自动缩放、光标平滑、画布布局、导出码率策略等）均来自原版；`LICENSE` 保留原作者的版权声明。
- **社区移植参考**：[@xiaoying8666/dogscwindows](https://github.com/xiaoying8666/dogscwindows)（MIT License）。
  本移植在以下模块参考了该项目对原版算法的移植方式，公式与常量逐值对齐：
  - **自动运镜**（AutoZoomPlanner + 自动跟随镜头）→ `src/renderer/editor/js/auto-zoom.js`
  - **光标弹簧平滑与点击锚定**（PointerTrack）→ `src/renderer/editor/js/pointer-smooth.js`
  - **导出活动看门狗与 BT.709 色彩标记** → `src/renderer/export/export.js`、`src/main/exporter.js`

  对照用的参考源码副本存档于 `docs/reference-xiaoying-port/`（含来源说明 `SOURCE.md`），供逐值查证。
- **随包字体**：Alibaba PuHuiTi 3，采用其自身许可，见 `resources/fonts/LICENSE.txt`。

---

## 许可

源代码沿用原版的 MIT License，版权归原作者所有。随包字体（Alibaba PuHuiTi 3）采用其自身许可，见 `resources/fonts/LICENSE.txt`。
