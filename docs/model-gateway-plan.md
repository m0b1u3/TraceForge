# TraceForge 模型网关实施计划

日期：2026-09-07。范围：本产品的独立多供应商/多协议模型接入；不是多用户平台、其他客户端配置管理器或公网代理。

最新进展：模型目录发现已贯通协议网关→宿主→受保护 IPC→桌面自动加载/选择/刷新/手动兜底。用户 Grok 登录重启恢复，真实获取 12 个模型，并在页面选择 grok-4.6 保存。104 项回归通过、1 项真实连接测试跳过；未发起生成验收。目录只说明该端点返回这些型号，不保证调用权限或所有能力。下一步仍为真实能力矩阵验收，不再要求用户手工寻找模型 ID。

源码参考补充：[CC Switch xAI 模型目录命令](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/commands/xai_oauth.rs) 用账号令牌读取 API_BASE/models；[通用目录命令](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/commands/model_fetch.rs) 分离界面命令与发现服务。本产品独立实现，不引入其他客户端管理；不复制跨路径猜测回退。目录首批最多 1000 项；上游分页暂不继续追取，明确显示不完整，不虚构全量结果。

当前验收基线：Grok 公开客户端兼容预设已装配到 settings-only 桌面，89 项通过、1 项真实连接跳过。下方旧测试数为批次历史。下一步是用户手动授权和真实模型能力验收，不再以必须先取得自有注册作为唯一实现路径；兼容入口不代表供应商合作身份、复用许可或套餐权限保证。

## 架构与职责

| 层 | 归属与边界 |
| --- | --- |
| 模型网关 | packages/llm：供应商元数据、协议适配、账号注册分派、认证传输。只返回 LlmProvider 合同，不执行工具。 |
| 宿主 | 安全存储、配置持久化、批准的 OAuth 注册、网关装配和受保护控制面。 |
| 桌面 | 连接表单、登录/取消/退出、状态反馈；不保管刷新令牌、不直接调用厂商。 |
| Model Runtime | 沿用现有角色路由、预算、并发、失败决策。网关不复制调度器。 |
| Core / Scenario | 使用统一模型能力；不增加供应商、登录或协议分支。 |

配置兼容：`provider` 是历史保留的**协议字段**（openai / anthropic / responses），不是供应商；`supplier` 为预设元数据；`credentialRef` 与 apiKey 二选一。协议是否在具体端点/型号可用必须独立验证，预设不是能力证明。自定义兼容端点不需要新增 Core 枚举。

## 本批实现与测试

最新补充：settings-only 宿主与桌面已接入安装级账号目录、设备授权操作、状态/退出确认和认证连接选择；独立 OS 加密 token 存储已装配。12 文件 / 87 项回归通过，真实供应商与 OS 安全存储实机验收仍未完成。完整操作和剩余边界见 [账号注册说明](model-account-registration.md)。下列后续目标中的通用装配部分已落地，具体供应商注册、默认发行和真实验收仍待完成。

- 三种协议通过 factory 装配。Responses 以标准 HTTP/SSE 独立实现，SDK 不必升级，不增加上游包依赖。结构化文本、函数调用/结果往返、文本流与用量回执有测试。
- ModelGateway 接收宿主注入的 ModelAccountConnection，不依赖设备授权实现或 OAuth 存储类型；createDeviceModelGateway 单独负责将批准的设备授权注册和秘密存储装配为连接。同一安装可连接多个模型账号，不是产品多用户。
- 宿主配置服务可注入网关，Responses 配置通过路由保存、重开、恢复与调用测试；renderer 有相应协议选项和切换回归。
- 失败不回传上游正文；新 Responses 适配器不自动重试、不自动改协议。流必须完成才能形成结果，缺失完成事件、失败/截断、无效函数参数、重复调用 ID、无对应调用的工具结果均拒绝。
- 模拟证明与实机证明分开：82 项回归通过，真实模型调用 0。API Key 表单存在不等于 Grok 账号登录交付。

## 后续按完整工作流交付

1. **账号连接真实验收**：通用装配和明确标识的 Grok 公开客户端兼容入口已实现；用户手动完成登录、模型调用、保存恢复、续期和退出验收。不读取其他客户端账号文件，不把公开 client ID 描述为本产品自有注册；发行前核实适用条件与权限，不用 API Key 测试替代订阅验收。
2. **多连接使用闭环**：保存命名连接、选择活动连接、编辑/删除的引用约束和失败反馈；把连接映射到既有模型路由，不另造角色调度。切换连接不隐式发送历史或复制密钥到不同端点。
3. **真实能力矩阵**：安装者授权后逐连接验证结构化输出、流式响应、工具参数及结果回传、取消、刷新与退出恢复；记录型号、协议、认证组合，不能把一家通过扩大为所有供应商通过。必要的供应商差异只在适配器或元数据能力中实现。

这三个目标属于同一网关开发任务；每批以完整链路验收，不以接口数量或文件数量交付。

## 明确剩余边界

Responses 当前采用无上游会话状态的文本/函数子集，`store:false`；尚不支持加密推理续接、图像/音频输入、内置搜索/MCP/代码执行工具和嵌入。遇到加密推理或不支持输出时显式失败，不丢弃后继续声称成功。普通 reasoning 摘要不转换为最终文本；涉及需要完整 reasoning 项重放的模型尚未验收。

不自动复制 CC Switch 的供应商特殊字段过滤或模型名猜测。协议扩展须说明可复用能力与转换损失，不能把某次账号/模型报错变为产品全局规则。既有适配器的重试语义尚未统一，需结合 Model Runtime 验证，避免输出重放或重复费用。

## 源码参考及许可

本次只参考架构和行为，独立实现 TypeScript，不引入 CC Switch Rust 源码或依赖。只读核对的固定版本为 `db34612807244643d85ccedf9704c965facc4cba`，固定版本 [Adapter trait](https://github.com/farion1231/cc-switch/blob/db34612807244643d85ccedf9704c965facc4cba/src-tauri/src/proxy/providers/adapter.rs) 及 [MIT LICENSE](https://github.com/farion1231/cc-switch/blob/db34612807244643d85ccedf9704c965facc4cba/LICENSE) 已读取。浏览器另核对 main 分支 [供应商分类](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/mod.rs)、[xAI 设备授权](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/xai_oauth_auth.rs)、[xAI Responses 转换](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/transform_codex_responses_xai_sanitize.rs)；这些 main 链接为可变参考，不声称固定版本文件逐项审计完成。

协议依据：[OpenAI 函数调用](https://developers.openai.com/api/docs/guides/function-calling)、[流式 Responses](https://developers.openai.com/api/docs/guides/streaming-responses)。第三方兼容实现与订阅权限必须另行确认，协议文档不是供应商套餐承诺。
