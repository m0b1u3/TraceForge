# TraceForge

TraceForge 是桌面端通用 AI 安全智能体应用，以智能体对话为主，任务、工具活动和证据按需展开。首发面向 macOS Apple Silicon；不是 Web 管理平台，也不以单独发布底座库为产品目标。

## 当前代码

- `apps/desktop`：Electron 桌面宿主、固定 IPC、会话与操作恢复。
- `apps/web/renderer`：全新桌面对话界面与独立设计预览；目录名沿用工作区容器，不包含旧 Web 应用。
- `apps/server`：本地宿主服务、持久化与 Runtime 装配。
- `packages`：通用 Agent、认知上下文、模型连接、授权、证据、受控工具与本地执行能力。
- `scenarios/web-blackbox`：独立进程形式的 Web 黑盒场景，不将场景策略写入通用底座。

旧 Web 源码、旧工具扩展包、MCP PoC、旧推理包及专属后端模块已删除，不提供旧链路兼容执行入口。新库不再创建旧应用专用表；已有数据库中的历史数据不会因本次代码清理而被删除。

## 开发运行

```bash
pnpm install
pnpm dev:desktop
```

桌面开发命令构建本地 Server、Renderer 与 Electron，并准备桌面运行时。直接在浏览器打开 Renderer 只会显示宿主未连接提示；真实工作台通过桌面宿主提供本机桥接。

模型连接在桌面设置中配置，协议和供应商接入与 Agent/Scenario 解耦。受控 MCP 与 Tool Provider 使用当前可信装配和沙箱链路，不再提供旧 `config/mcp.json` 直接拉起进程的入口。

## 验证与发布边界

```bash
pnpm test:fast
pnpm build
```

部分真实环境测试需要单独配置 Chromium、原生沙箱或模型。测试/构建基线及未验收项以[开发计划](docs/development-status-and-roadmap.md)为准，不将缺少环境的测试记作通过。

开发桌面可以运行；正式安装包发布仍有验收门禁。本次清理没有解除打包门禁，也没有新增远程执行节点、多用户平台或自动更新系统。

## 文档

- [开发状态与下一优先级](docs/development-status-and-roadmap.md)
- [桌面工作台界面合同](docs/desktop-renderer-surface-brief.md)
- [模型连接](docs/model-connections.md)
- [Runtime 依赖边界](docs/architecture/runtime-dependency-map.md)
- [Scenario Control Plane](docs/scenario-control-plane-api.md)

具体安全分析方法属于 Scenario 或工具插件。安全结论需要可追溯证据链、可复现因果机制与明确影响；同一 Run 保留多个假设，但一次只执行一个验证任务。
