---
name: TraceForge · 行动谱面
description: 已实现的独立桌面 renderer 预览视觉系统
colors:
  ink: "#202329"
  muted: "#626875"
  line: "#d9dce2"
  soft: "#f5f6f7"
  paper: "#fff"
  primary: "#292e35"
  primary-hover: "#414854"
  selected: "#f2f3f5"
  pending-ink: "#895006"
  pending-line: "#e7bd84"
  pending-paper: "#fffaf1"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "18px"
    lineHeight: 1.7
  headline:
    fontSize: "32px"
    fontWeight: 600
    letterSpacing: "-.03em"
  title:
    fontSize: "22px"
    fontWeight: 600
  label:
    fontSize: "14px"
    lineHeight: 1.5
rounded:
  control: "8px"
  bubble: "10px"
  modal: "12px"
  status: "5px"
spacing:
  small: "8px"
  medium: "12px"
  regular: "16px"
  roomy: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  status-pending:
    backgroundColor: "{colors.pending-paper}"
    textColor: "{colors.pending-ink}"
    rounded: "{rounded.status}"
    padding: "3px 10px"
  user-message:
    backgroundColor: "{colors.soft}"
    rounded: "{rounded.bubble}"
    padding: "8px 18px"
---

# Design System: TraceForge · 行动谱面

## Overview

2026-09-08 宿主视觉增量：HostWorkbench 已实现用户确认的“对话内确认卡”方向，批准图为 `.impeccable/mocks/authorization-desktop-A-20260908.png`。白色桌面壳、窄图标导航和对话正文后的单张授权卡构成当前宿主基线；具体记录见下方 Host desktop 小节。浏览器合成状态的截图不构成 Electron 原生桌面或真实执行整链验收。

**Creative North Star: "行动谱面"**

白色阅读面、石板色文字和细分隔线构成平静、明确的调查对话空间。对话承担阅读主线，任务、来源和时间标记作为可检查的旁注；按钮与边界克制，强调信息关系而非装饰。

本文保留 `apps/web/renderer` 独立交互预览的视觉记录，并在 Host desktop 小节单独记录当前宿主实现。前置 token 及未注明宿主的尺寸、模态框和演示交互描述属于独立 Workbench，不是宿主覆盖样式的规范。独立预览依据为 A 并列核查及用户消息居右、智能体回复居左的后续修正；它没有真实 Host、模型或调查存档接线。旧 `apps/web/src` 已退役，不能作为视觉继承来源。

**Key Characteristics:**

- 白底、细线、石板色文字，暖色仅提示待确认状态。
- 用户消息居右，智能体回复居左。
- 对话主导，任务、证据与行动时间可按需查看。
- 演示、未送达与未验证状态始终可辨。

实现来源：`apps/web/renderer/index.html`、`workbench.css`、`workbench.tsx`、`preview-state.ts`；首屏策略详见 `docs/desktop-renderer-surface-brief.md`，能力边界详见 `docs/desktop-renderer-preview.md`。

## Colors

主色是沉稳的深石板灰，中性色通过明度区分文字、阅读面、消息底色和边界。前置 token 是规范值；这里说明用途。

### Primary

深石板灰用于确认动作和可用的发送按钮；悬停加亮。普通正文使用 ink，避免每段内容都获得按钮的视觉重量。

### Secondary

暖琥珀用于等待确认标签与存储提示。它表达需要注意的状态，不表达已确认的安全发现。

### Neutral

paper 是主阅读面和侧区底色；soft 用于用户消息与轻量辅助区域；muted 用于时间、限制说明和辅助文案；line 用于侧区、计划条目与控件边界。selected 是对话导航的浅色选中底。

## Typography

使用系统中英文无衬线字体栈，不依赖远程字体。标题为中等偏粗，正文保留充足行高，时间使用等宽数字；没有展示型大字或装饰字体。

桌面会话标题使用 headline，侧区标题使用 title，消息正文使用 body，状态使用 label。正文最大宽度（75ch），用户消息最大宽度（65ch）。在（1350px）及以下消息降至（16px），在（540px）及以下为（15px）；输入框在窄屏仍为（16px）。会话标题在（900px）及以下为（27px），最窄断点为（23px）。

## Layout

桌面壳占满动态视口，顶部栏（67px），左导航（115px）。中间对话为弹性列，证据侧区（370px），行动轨（204px）；各自使用细线分隔。对话正文独立滚动，输入区保留在其下方；正文容器最大宽度（1150px）。默认桌面展示证据与时间轨，来源记录初始收起。

在（1350px）及以下导航收窄至（80px），证据侧区为（310px），时间轨按需打开；有证据侧区时隐藏时间轨。在（900px）及以下，侧区或时间轨替换对话内容，用户可通过对话导航返回；新会话存储为空时首先显示对话。在（540px）及以下顶部（60px）、底部导航（66px），正文区域占剩余高度，导航切换为横向。

间距以 token 中的重复步长为主，但实现不是严格的单一网格。计划及审批区域在窄屏换行，审批操作在最窄断点占独立一行；长对话通过滚动访问，不能把桌面首屏完整性当成移动端无滚动承诺。

## Elevation & Depth

主界面无阴影，通过边界与浅色底区分层次。只有模态框使用阴影（`0 20px 70px rgb(26 31 40 / 18%)`），配合半透明遮罩（`rgb(26 31 40 / 28%)`）表明需要处理的独立对话。

模态框出现采用（180ms）裁切与透明度动画，缓动（`cubic-bezier(.16, 1, .3, 1)`）；减少动态效果偏好下禁用。没有常驻装饰动画。

## Shapes

控件和计划采用轻圆角，消息气泡与输入容器略柔和，模态框圆角最大。头像、步骤编号和发送按钮为圆形。主要边界为单像素实线；标签使用更紧凑圆角。线性图标为主要图形语言，用户及智能体头像使用实心符号。

## Components

### Host desktop · 2026-09-08

宿主以精致、克制的白色对话桌面为方向，覆盖样式单独维护在 `apps/web/renderer/host-workbench.css`，由 `host-workbench.tsx` 引入。独立 Workbench 仍保留自己的演示布局；以下数值仅描述宿主覆盖样式，不替换前置预览 token。

- 桌面顶部栏（54px）、左导航（72px），会话标题位于顶部。导航以有可访问名称的细线图标呈现，选中项为浅灰底；不伪造 macOS 窗口按钮。任务、证据、设置和会话记录按需切换，并提供返回对话入口。
- 对话容器最大宽度（1060px），桌面内边距（42px 40px 30px）。用户浅灰消息居右，最大占宽（78%），圆角（16px）；隐藏大头像，正文（15px）及行高（1.75），署名（12px）。宿主保存回执、运行状态和已保存输出仍各自表达真实含义。
- 授权区位于对话正文之后，容器最大宽度（640px）。单卡使用近白底、细灰边、圆角（12px）及内边距（24px），没有卡片阴影。Shield 与标题（15px）引导核对；范围值（18px）先于操作说明（14px），高级策略按需展开。编辑与核对替换同一卡片内容；底部左侧返回修改、右侧深灰确认按钮，明确同意后才可登记。
- 输入区最大宽度（940px），浅底容器圆角（15px）；文本占上行，真实模型设置入口、保存提示与右下圆形发送按钮位于下行。发送保存调查说明，授权登记不会自动启动任务。附件与模型切换等尚无对应能力的装饰控件不出现。
- 在（650px）及以下顶部栏降至（50px），导航移至底部（54px）；正文内边距（24px 18px），授权卡内边距（18px），用户消息最大占宽（90%）。键盘焦点为（2px）灰色轮廓，偏移（3px）；长范围保持折行。

实现来源另含 `authorization-form.tsx`、`conversation-execution.tsx`。浏览器合成截图为 `output/playwright/authorization-card-desktop.png` 与 `output/playwright/authorization-card-narrow.png`；只能佐证对应 renderer 状态，不是原生桌面验收。

### Host execution progress and control · 2026-09-08

宿主对话内以轻量文字呈现最新执行进展，记录列表默认收起，使用原生 details 与 CaretRight 展开“执行记录”和“查看操作依据”。进展区最大宽度（70ch），长内容可折行；记录正文（13px）、时间与角色（11px）、状态及说明（12px）。保留最近（100条）记录，超过时明确标注“最近”；审批状态仅展示，不提供自动批准行为，工具完成也不等于安全结论已验证。

进展通过 GET 轮询读取；读取失败保留已显示记录，以 alert 提示并提供“重新读取进展”，重试不重跑操作。“停止调查”采用透明底、细灰边的小按钮，沿用任务面板的持久命令控制器；有待确认请求时提供“核对原请求”，核对期间禁用重复操作。本地待确认记录不可读时暂停操作并显示 alert；宿主确认停止的回执仍说明外部副作用不因此撤销。

实现来源：`apps/web/renderer/run-progress.tsx`、`run-control.tsx`、`host-workbench.css`。浏览器合成状态截图为 `output/playwright/progress-desktop.png` 与 `output/playwright/progress-narrow.png`，用于核对 renderer 的桌面及窄屏呈现，不构成真实执行整链或 Electron 原生桌面验收。

### Host approval and supplemental input · 2026-09-08

操作审批延续白色对话内确认卡：容器最大宽度（640px），近白卡面、细灰边、圆角（12px）及内边距（20px）。卡片先展示工作项标题、工具与风险、请求原因；操作标识按需展开。“查看具体参数”显式读取并核对本次输入，以可聚焦的只读原文区呈现，最大高度（240px），长行折行并可滚动。参数未读取或核对失败时禁用批准，填写处理说明后仍可拒绝。批准还需勾选明确同意；同意绑定当前审批、运行修订与处理说明，内容变化后需重新确认。

“补充信息”使用原生 details 收起，展开后选择对应工作项并填写多行文本；已保存的操作员补充信息另行按需查看。文案明确补充内容进入所选工作项上下文，不扩大授权，也不自动恢复或重试工具。输入控件为白底细边、圆角（7px），操作按钮可换行。审批与补充输入沿用共享持久命令控制器；待核对状态展示原操作及运行标识，阻止重复提交，恢复核对成功后仅清空与原请求匹配的补充草稿。错误使用 alert，保存与审批回执使用 status。

实现来源：`apps/web/renderer/run-interaction.tsx`、`host-workbench.css`。本批浏览器合成状态截图为 `output/playwright/interaction-desktop.png` 与 `output/playwright/interaction-narrow.png`；未进行真实模型运行，不构成 Electron 原生桌面或真实执行整链验收。

### Buttons

主按钮为深底白字，次按钮为白底细边。默认最小高度（40px），图标按钮通常为（40px）正方形。悬停改变底色和边界，按下有中性灰反馈。禁用状态灰底灰字。键盘焦点使用（2px）石板色外轮廓，偏移（4px）。引用按钮为带下划线的文字与方向图标。

### Messages and plan

用户消息右侧头像与浅灰气泡；智能体左侧头像与开放白底正文。发送者与时间保持独立一行。计划为细边框列表，条目以圆形编号、标题、说明和引用动作构成，不使用安全类型专属卡片。

### Composer

输入容器为细边框、圆角和三列结构：附件未接通提示、文本框、圆形发送。聚焦时边界加深。Enter 添加预览消息，Shift+Enter 换行；输入法组合事件不发送。空白或达到（40条）时禁用发送，单条上限（4000字）。输入只显示纯文本；新增消息附“未送达模型”回执，不生成模拟智能体回答。

### Navigation and inspector

左侧导航图标在文字上方，当前对话以浅色底标识。证据与任务按钮切换同一侧区；侧区内选项以底部细线强调。来源使用原生可展开条目，引用可打开来源并转移焦点。初始回复使用“可以查看来源记录”，不声称来源已经展开。来源、限制和状态独立呈现。

### Status and approval

紧凑描边标签承担状态；等待确认增加暖底与暖色边界。审批条同时包含说明、暂缓和查看确认入口。确认入口打开带范围与执行说明的模态框，再次确认只改变本页状态。聊天文字不改变审批决定，观察仍待验证、任务仍未执行。

### Dialogs and local feedback

设置、模拟审批和重置使用同一模态容器，具备焦点约束、Escape 关闭与焦点返回。重置有确认步骤。状态通知与存储错误分别使用 status 和 alert 语义。sessionStorage 只恢复当前标签页的草稿、手动消息、面板与模拟决定；这不是宿主恢复能力。

## Do's and Don'ts

### Do:

- Do 保持用户消息居右、智能体回复居左。
- Do 保持白色阅读面、细分隔线与克制的石板色控件。
- Do 保留来源、状态、限制与操作回执的可见区分。
- Do 让侧区在窄窗口可切换，并保留返回对话的入口。

### Don't:

- Don't 从已退役的旧 Web 前端继承布局、配色或 API 假设。
- Don't 把演示确认、消息添加或单条观察呈现为真实执行、模型送达或已验证发现。
- Don't 将选择页的黑黄外围装饰或草图手绘线条带入此界面。
