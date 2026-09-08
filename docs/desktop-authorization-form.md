# 桌面场景授权表单

本页记录 2026-09-08 已实现的宿主“对话内确认卡”。用户批准 `.impeccable/mocks/authorization-desktop-A-20260908.png`，否定冗长的后台式嵌套表单；当前实现将授权放在对话正文后的单张浅底细边卡内，主要输入在先，可选范围按需展开，核对替换编辑。宿主视觉以根目录 `DESIGN.md` 的 Host desktop 小节为准，独立 Workbench 演示布局仍单独保留。产品能力与验收基线以 `development-status-and-roadmap.md` 为准。

## 交互与状态

- 没有有效授权时展开“设置授权范围”；已有授权时提供“登记新的场景授权”。单个场景直接显示名称和版本，多个场景使用选择控件。
- 非高级字段及所有必填字段直接显示。仅 `advanced: true` 且非必填的字段收入“更多范围选项”；字段顺序、名称、说明和操作中文名称均由 Scenario 声明。当前 Web 场景先显示“精确地址”，地址前缀与身份句柄按需展开，这不是其他 Scenario 的固定字段模板。
- “核对授权”按行读取原文，去除首尾空白和空行，校验必填、数量、长度与总大小。不会推断协议、同站点范围、通配符或前缀。空字段成为空列表，不新增对应资源权限。
- 核对页显示非空输入、允许与禁止操作，以及策略声明的固定资源范围。高级策略详情默认折叠；当前接口提供的是动作与资源规则投影。操作名称优先使用 Scenario 的 `actionLabels`，缺少标签时显示原标识。
- “返回修改”保留输入并清除确认。编辑内容或切换表单合同后必须重新核对；核对时生成一小时有效期，提交时若已过期则要求重新核对。
- 勾选“我有权授权，并确认以上范围和操作”后才能“确认登记授权”。成功后清空本次表单并选择新授权；登记不会启动 Run。启动调查仍需单独选择有效授权、具备模型与已保存调查说明，再确认启动。忙碌或请求结果待核对时禁用授权操作；失败保留可核对状态。

## 控件、键盘与视觉复用

使用原生 `textarea`、`details/summary`、复选框、按钮、选择框及禁用 `fieldset`。标签包裹输入，装饰箭头不参与无障碍朗读；错误使用 `alert`，宿主回执使用 `status`。Tab 按文档顺序访问控件，折叠项保留原生键盘行为，文本框内 Enter 换行，不触发登记。编辑与核对切换目前没有自定义焦点迁移，不将浏览器默认焦点行为描述为完整辅助技术验收。

宿主使用系统字体和白色阅读面，覆盖样式位于 `apps/web/renderer/host-workbench.css`，隔离于独立演示。顶部栏（54px）与左侧图标导航（72px）保持轻量；对话去除大头像，用户浅灰消息居右。授权区最大宽度（640px），内含沿用基础最大宽度（560px）的单张表单卡：近白底、细灰边、圆角（12px）、内边距（24px），没有阴影。Shield 与卡标题（15px）引导阅读，核对范围值（18px）为重点，操作说明（14px）次之，高级策略收起。底部“返回修改”与“确认登记授权”分列两端，同意复选框保留真实门槛。原先仅由 `workbench.css` 描述的表单外观不再是宿主视觉基线。

文本框允许纵向调整，长范围值自动折行，策略文本在受限高度内滚动。窗口宽度（650px）及以下导航移至底部，卡内边距降至（18px）。键盘焦点使用（2px）灰色轮廓、偏移（3px）。底部短输入容器提供真实模型设置入口及右下圆形保存按钮；不显示没有功能的附件、模型切换或伪造窗口按钮。

## 合同与授权边界

v1 为数据声明，只支持 `string-list`，不支持 HTML、脚本或场景自定义执行代码。共享 schema 限制字段路径并拒绝路径重叠；Scenario SDK 要求字段恰好覆盖策略的动态资源路径，动作标签只能引用策略已声明动作。renderer 负责收集和展示，宿主继续解析范围、验证声明、检查有效期并绑定策略；表单不替代授权执行判断。

`form` 属于 `authorizationPolicy`，其变更影响既有策略哈希和授权绑定。不能静默迁移已有授权，也不能为界面文案变化绕过策略绑定校验；需要按现有恢复或重新授权流程处理。

实现入口：`apps/web/renderer/host-workbench.tsx`、`host-workbench.css`、`conversation-execution.tsx`、`authorization-form.tsx`、`execution-panel.tsx`、`packages/shared/src/authorization-form.ts`、`packages/scenario-sdk/src/declarative-contracts.ts`、`scenarios/web-blackbox/scenario.json` 与 `apps/server/src/scenario-routes.ts`。

## 验证边界

本轮 renderer 的 19 项测试与构建通过；合成状态截图位于 `output/playwright/authorization-card-desktop.png` 与 `output/playwright/authorization-card-narrow.png`。这些检查只能说明对应 renderer 状态与控件行为，不能替代 Electron 原生桌面、macOS Apple Silicon 隔离、真实模型调用或目标请求整链验收。具体测试基线由项目计划统一记录。
