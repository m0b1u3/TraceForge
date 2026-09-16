# TraceForge 产品基线

<!-- impeccable:product-schema 1 -->

## Platform

web

此字段只表示渲染技术类别：产品是 Electron 桌面软件，不是公网 Web 平台，也不是手机原生应用。新桌面交互不能沿用已废弃 Web 应用的设计。

## Users

面向不同安装者，每个安装实例为单用户使用；不是开发者个人专用，也不建设多用户平台。

## Product Purpose

通用安全智能体工作台。底座负责运行、授权、受控执行、证据和恢复；安全场景独立装配。

## Operating Context

用户已确认：智能体对话为主，任务与证据按需展开。模型可由安装者配置云端来源，不依赖开发者个人代理或其他客户端配置。执行以本机沙箱为主，不需要远程执行节点。

## Capabilities and Constraints

- 首发支持 macOS Apple Silicon（darwin/arm64），本机执行；Linux 后续再测试。不得将 Linux 主机、远程节点或 macOS 仅控制面当作首发前提。原生隔离与 Browser 整链需在 macOS 实际验证，不能以其他平台实现或浏览器控制测试代替。

- 旧前端已获准删除，旧布局、颜色、组件和 API 客户端均不是新设计依据。
- 只对接核实有效的当前宿主合同；不能因旧界面使用过某接口，就认定接口适用。
- Core、Scenario、模型接入、桌面展示保持解耦。
- 暂不开发桌面更新系统；真实模型与平台验收不能以模拟结果冒充。
- 用户已确认“行动谱面 / A 并列核查”，并进一步明确自己的消息居右、智能体回复居左。真实 HostWorkbench 已接入桌面桥接、模型流式回复与本机对话存档；无桌面桥接时的独立预览仍为演示。已有接线不等于完整产品或正式发布验收完成，具体缺口以当前路线图为准。

## Brand Commitments

用户指定行动谱面草图为布局依据：左侧窄导航、中央对话与底部输入、右侧按需展开的任务/证据及行动时间标记。精致程度对标 Claude Desktop 与 ChatGPT 桌面端，但不复制其品牌。草图手绘线条不作为生产视觉要求；不使用选择页外围的黑黄装饰。用户文字/截图确认有效，无须选择页按钮成功。

## Evidence on Hand

当前宿主入口为 apps/server/src/main.ts，包含 Foundation 注册、Host Control 与模型 Secret Store；apps/desktop/src/main.ts 是本机装配入口，不是旧后端已经全部可删除的证据。能力状态以 docs/development-status-and-roadmap.md 为准。

## Product Principles

- 用自然语言操作，以可追溯证据核查结果。
- 展示层不替代后端授权、执行或结论验证。
- 场景专用信息按需展示，不成为通用工作台的固定语义。
- 真实状态优先；未接通、未知效果与未验证结果必须明确表达。
