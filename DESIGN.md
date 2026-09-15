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

2026-09-15 宿主对话入口更新：下方历史“消息用途”选择描述已被统一助手输入替代。新任务由助手通过宿主提案端口提出，在绑定的原消息下核对授权；该入口的确认按钮明确为“授权并执行本条任务”。独立设置的授权登记仍不自动启动。输入、停止、过程和范围确认继续沿用现有白底细边风格；详细实现及验收边界见 `docs/desktop-renderer-surface-brief.md` 与当前路线图，不将 UI 提案视作执行事实。

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

### Host configuration settings · 2026-09-08

宿主设置延续白底“行动谱面”，以“模型连接”和“场景与扩展”分类导航进入配置。分类使用浅灰选中底与细分隔线，首次打开场景分类才读取配置；分类间切换保留已打开的场景编辑状态。设置页隐藏对话输入框，保留全局状态与错误提示。

场景配置容器最大宽度（980px），顶部白底工具栏随滚动保留场景选择、重新读取与保存动作，底部再次提供保存入口。资源区为列表与正文两列：列表宽度（140–220px）、列间距（24px），资源名称下显示类型，选中项为浅灰底。正文先展示摘要、适用角色与阶段，再展示启用开关和指导内容；不可编辑资源显示原因。白底细边文本框圆角（8px），最小高度（280px），可纵向调整大小；辅助修订与状态文字为（13px）。在（700px）及以下改为单列，资源列表横向排列并换行。

“查看包内默认内容”使用原生 details 展开只读正文，浅灰阅读面最大高度（360px），长行折行且可聚焦滚动。“恢复默认内容”先显示行内确认，确认只改变草稿，保存后生效；正文来源明确区分默认内容与用户修改。修订编号、未保存状态和保存回执紧邻编辑动作，文案说明配置用于新 Run（界面称“新任务”），已有任务保持原配置。

MCP 区仅展示宿主已审核连接：连接启用开关下按需展开工具复选列表，并显示已选数量；连接禁用时工具选择不可操作。界面明确此处不创建连接、不启动进程，配置不能扩大授权或绕过沙箱。这是已实现资源编辑与已审核工具选择的组件记录，不表示完整配置管理需求均已完成。

有草稿时禁用场景切换，重新读取须确认丢弃；读取或保存失败保留草稿，以 alert 提示，成功回执使用 status。保存处理中禁用编辑及重复保存；未保存或处理中阻止离开设置，并提示返回场景分类保存或确认丢弃。窗口离开时对未保存草稿触发浏览器提示，这不代表草稿已持久保存。焦点使用（2px）灰色轮廓、偏移（3px），确认区通过上下细线与正文区分。

“我的 Skills 与指导”沿用白色资源列表、正文编辑器与显式保存流程，可新建独立文本 Skill、角色指导和知识资料，编辑名称、类型、正文及启停状态。读取边界选自包内可编辑且声明角色的父资源；角色和阶段选项来自该父资源，阶段不选表示继承全部。没有可继承边界时说明原因并禁用新建。资源列表附类型与启停状态，保持上述两列布局和（700px）单列断点。

正文导入使用文件选择控件，仅接受不超过（64 KiB）的有效 UTF-8 Markdown / TXT；导入不安装或执行脚本。已有正文时先显示“替换正文”行内确认，等待处理期间禁用资源编辑、切换、新建及父级保存、重新读取，并阻止离开设置。启动导入收起删除确认，替换待确认时不能再发起删除。删除使用独立行内确认，导入替换和删除均先改变草稿，保存后影响后续任务，已有任务保留原配置；读取失败通过 alert 说明原因。

实现来源：`apps/web/renderer/configuration-settings.tsx`、`configuration-settings.css`、`user-resources.tsx`、`workbench-settings.tsx`、`host-workbench.tsx`。用户资源浏览器截图为 `output/playwright/user-resources-desktop.png` 与 `output/playwright/user-resources-narrow.png`；上述说明以实际组件为依据，不构成 Electron 原生桌面或真实模型执行整链验收，MCP 新连接编辑仍不在本组件能力内。

### Host MCP connection settings · 2026-09-08

MCP 连接管理扩展既有白色 Operate 设置面，沿用细灰分隔线、浅灰选中项和连接列表／正文两列布局；不新增全局视觉 token。连接列表显示启用状态与草稿修订，正文按连接配置、保存、显式测试发现、工具审核及启用顺序组织。在（700px）及以下正文改为单列，连接列表横向换行，操作按钮保持可换行。

“保存连接”仅保存修订；“测试并发现工具”通过行内确认明确展示将连接的服务或执行的本地程序及文件访问范围。发现后以原生 details 逐项展开工具、可聚焦的输入契约和资源授权选择，再由“审核并启用”确认激活。“当前生效”单独按需展开修订详情，使已保存草稿与实际启用状态可辨。停用和删除保留独立动作与结果回执。

凭证使用仅写入的密码输入框，以已保存／未设置提示替代回显；安全存储不可用时禁用输入，另设清除新修订凭证开关。失败用 alert 保留配置草稿并说明凭证输入已清空，成功用 status 表达对应操作结果；未保存编辑、待确认和处理中状态阻止重复操作及离开设置。

实现来源：`apps/web/renderer/mcp-settings.tsx`、`configuration-settings.css`。此独立连接组件补充上方场景配置内的已审核工具选择；以上为组件实现记录，不构成 Electron 原生桌面或真实服务执行整链验收。

### Host conversation journey · 2026-09-08

宿主新会话延续白色阅读面，空态以“这次想调查什么？”和简短授权说明引导直接输入，并提供配置模型与工具、继续已有会话入口。输入框随正文增高，最高（180px）后内部滚动；Enter 发送、Shift+Enter 换行，输入法组合期间不发送。首次发送创建会话并保存说明，后续仍须明确确认范围与启动调查，不自动执行。

顶部提供新建对话，快捷键为 Cmd/Ctrl+Shift+N；Cmd/Ctrl+K 打开会话记录并聚焦标题搜索，Cmd/Ctrl+逗号进入设置。会话记录以细分隔线列表呈现标题和创建日期，支持标题筛选与无匹配反馈。新建返回输入框；设置未保存或处理中时保留既有离开保护。

未发送文本按会话分别保留为当前窗口会话草稿，新会话也有独立草稿；输入区显示字数与“窗口草稿”，明确关闭前需发送或复制。窗口存储失败通过 alert 提示，有文本且无法保留时阻止会话切换；这不表示跨窗口或应用重启后的持久恢复。发送确认保存后清理对应草稿。

对话正文独立滚动，读者位于末尾附近时跟随新增内容；向上阅读时保持当前位置，并在底部中央显示白底细边的“回到最新内容”按钮。点击后恢复跟随；切换会话或面板会重置位置，对话从末尾显示，其他面板从顶部显示，不声称跨切换记忆阅读位置。

实现来源：`apps/web/renderer/host-workbench.tsx`、`host-workbench.css`、`conversation-drafts.ts`、`conversation-viewport.tsx`。本节仅记录当前组件行为，沿用宿主视觉，不改变独立预览 token，也不构成 Electron 原生桌面或真实执行整链验收。

### Host unified composer and pause / resume · 2026-09-08

统一输入框延续现有白色桌面、浅底圆角输入面与深灰圆形发送按钮。输入框上方以“发送到”下拉框明确本条消息用途：新的调查说明，或补充给指定工作项；选择器的可访问名称为“消息用途”。仅有一个可接收工作项时可预选，多个候选时须明确选择。开始输入后固定接收目标；原任务结束或不可用时显示 alert 并保留草稿，禁止静默转发到其他任务或新的调查说明。

补充模式下，文本框与发送按钮的可访问名称分别为“补充信息”和“发送补充信息”，旁文显示工作项名称及暂停状态。补充保存回执说明其供后续处理使用，不自动恢复调查、重试工具或扩大授权。用途区最高（240px）后内部滚动，白底细边选择器圆角（7px），操作按钮可换行，沿用宿主键盘焦点样式。

运行时显式提供“暂停调查”；暂停后通过“恢复调查”展开名为“恢复调查确认”的行内组，说明恢复可能继续已授权工作，再由“确认恢复”提交或“保持暂停”收起。暂停本身是独立直接动作，恢复须二次确认；补充消息不能代替恢复确认。待处理请求与损坏记录继续禁用重复操作，并提供原请求核对或错误提示。

实现来源：`apps/web/renderer/conversation-composer.tsx`、`run-control.tsx`、`host-workbench.css`。本节仅记录这些组件的当前行为与既有宿主视觉，不重写全局 token，不构成整产品成熟度、Electron 原生桌面或真实执行整链验收。

### Host assistant replies and explicit message routing · 2026-09-08

助手回复延续白色 macOS 风格对话桌面：用户浅灰消息居右，助手开放正文居左，署名旁以轻量状态文字区分正在回复、回复完成、已停止、中断与未完成。正文使用纯文本，保留换行并允许长行任意折行，字号（15px）、行高（1.8）、最大宽度（75ch）；不解析 HTML 或 Markdown，也不添加模拟打字动画。等待真实输出时显示“正在等待模型输出…”。

回复下方提供“停止回复”和“复制回复”，透明底、细灰边、圆角（7px）、最小高度（36px），操作与回执可换行。停止仅针对本条助手回复，与“停止调查”分属不同操作；请求处理中禁用重复点击。停止、中断或失败仍保留已收到正文，并说明不会自动续写或重试，继续需要发送新消息。复制成功使用 status，失败使用 alert 并提示手动复制。完成回执明确本机保存不代表已验证的调查结论；上下文被截短时另行提示较早消息未发送给模型。

本节更新上方统一输入框与新会话条目的消息用途：没有活动调查时默认“与助手对话（不执行工具）”；只有一个可接收工作项时可预选补充目标，有活动调查但目标不唯一时要求明确选择。下拉框同时保留“仅保存调查说明，稍后授权启动”，使模型对话、指定任务补充和仅保存三种用途可辨。输入后固定目标，目标失效时保留草稿并要求重新选择；补充消息仍不自动恢复调查、重试工具或扩大授权。

打开会话、重连及“重新读取回复”只读取保存记录。同步失败保留已显示文字，通过 alert 提供读取恢复入口，不重新请求模型；尚无回复的已保存消息提供显式“请求助手回复”，记录未读完或另一条回复仍生成时禁用。模型未就绪、容量冲突或结果未确认分别显示对应说明，保留原消息。调查授权入口使用默认收起的原生 details：“授权并启动调查”展开后才呈现既有授权卡，容器最大宽度（640px），摘要字号（14px）；聊天回复不代替授权确认。

实现来源：`apps/web/renderer/conversation-replies.tsx`、`conversation-composer.tsx`、`conversation-execution.tsx`、`host-workbench.css`。本批浏览器截图记录路径为 `output/playwright/replies-desktop.png` 与 `output/playwright/replies-narrow.png`；本节按组件实现记录增量，沿用既有窄屏布局与全局 token，不构成 Electron 原生桌面或真实模型执行整链验收。

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
# Task autonomy consent — 2026-09-08

Numeric execution budgets use the same Scenario-driven authorization surface, not a new settings dashboard. Show bounded integer inputs and default/range help in the optional disclosure, then display the exact values during explicit review. Editing invalidates review and consent. The form owns vertical label/input/help layout, so it remains readable without a specific parent screen; text areas use the available width and number fields stay compact. Desktop and narrow synthetic screenshots were checked; no actual authorization was submitted.

Model permission requests reuse the paper/ink authorization surface. When a Run pauses with a pending request, show the model's reason, a disclosed comparison of current scope and proposal, and the existing editable Scenario form. Proposal text is not consent. Approval requires the exact reviewed scope and a reason; rejection separately confirms unchanged authorization and continuation. Both actions explicitly say they continue the original Work. Manual scope amendments keep their existing save-without-resume semantics. Persist uncertain decisions before sending, reconcile the original receipt after remount, and keep Stop available. Expired or stale requests never silently become new grants. Impeccable hardening guided these state and recovery choices; desktop and narrow-window synthetic review screenshots showed no horizontal overflow.

Paused tasks expose an explicit permission-change action using the existing Scenario-owned authorization form, prefilled from the current scope. A reason and renewed review are required; the original expiry stays visible. Saving never resumes work. Uncertain requests retain their identity across remounts and block resume until reconciled, while stopping remains available. This is an extension of the current authorization surface, not a new administration screen.

The existing authorization surface now supports data-driven boolean consent fields. They start unchecked, retain the user's draft when returning from review, and are rendered explicitly as allowed/not allowed in the final authorization review. Scenario owns labels and scope meaning; the desktop renders no Scenario-specific policy. This extends the existing paper/ink authorization surface rather than introducing another settings dashboard. Scope consent must never be inferred from submitting a text field or merely opening the form.
