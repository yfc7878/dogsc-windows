# 参考资料：原版 DogSC v0.1.7 关键源码

文件来自 https://github.com/laogou717/dogsc 的 `v0.1.7` 标签（2026-10-14），
收录 0.1.2 → 0.1.7 期间新增 / 重点更新的模块，供 Windows 移植借鉴参考：

| 文件 | 说明 |
| --- | --- |
| `AppLocalization.swift` | 实时语言切换：词表快照 + 字符串缓存（时间轴高频取词）+ 窗口标题刷新 |
| `EditorPersistenceIndicator.swift` | 保存状态徽章：已保存 / 正在保存 / 编辑中 / 保存失败，跟随真实写入管线 |
| `EditorZoomEnvelope.swift` | 缩放包络曲线编辑器：对数刻度、三节点（进入/峰值/退出）、播放头联动 |
| `EditorOpeningTimeline.swift` + `EditorOpeningTiming.swift` | 开场时序条编辑器：共享排期（总时长 + 间隔），逐元素条形时间轴 |
| `EditorInspectorTabBar.swift` | 检查器任务标签（画面/光标/缩放/运镜/开场/声音），未就绪灰显 |
| `EditorInspectorKnobs.swift` + `EditorKnobInput.swift` | 旋钮控件与输入：拖拽跟随 / 滚轮（惯性抑制）/ Shift 精细 |
| `EditorBarSlider.swift` | 条形滑块：Shift 精调、双击复位、方向键步进、滚轮 |
| `EditorMockupTurntable.swift` | 样机旋转轮盘 + 11 种样机样式清单 |
| `EditorDesignTokens.swift` | 设计令牌：Soft Silver / Graphite 配色、字号/圆角/动效参数 |
| `AppChoiceFeedback.swift` | 选择按压反馈：最短可见时长 0.10s、选中/未选中分别响应 |
| `RecorderPanelInteraction.swift` | 录制条拖动把手与点击穿透区域 |
| `RecordingCompletionTransition.swift` / `CaptureAreaSelectionMotion.swift` | 完成窗口与区域选择的无过冲过渡动画 |
| `CaptureReadiness.swift` | 录制前就绪检查：磁盘空间按 1 分钟用量估算、帧率与刷新率提示 |

授权：原项目为 MIT License，版权归原作者 神烦老狗（laogou717）所有。
本目录仅作移植对比学习之用。
