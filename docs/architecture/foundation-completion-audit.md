# 通用安全智能体底座完成度审查

更新日期：2026-09-03。本审查按实际生产调用路径区分“仓库实现完成”“应用接线欠账”和“外部发布验收”，不以接口、测试数量或计划文字代替可达代码。

## 审查结论

通用底座的仓库内主链已经具备首个安全 Scenario Package 接入所需的稳定边界：Core 不认识具体场景；Package 可由签名纯数据描述构造；Skill、Knowledge、本地迁移声明和外部 MCP 引用进入统一装配；正式场景工具只能经 Scenario Process、Extension Assembly、Execution Node、Gateway、授权和回执链执行；撤销、重启、未知结果、容量、归档和恢复均有 fail-closed 路径。

本轮审查发现并修复一个真实阻断：描述文件声明的本地 Skill、Knowledge 和迁移正文此前仍需宿主重复传入。现在 Foundation 只从当前受信的审核材料读取这些文件，逐项复核路径、角色、字节数、SHA-256、稳定文件身份和严格 UTF-8，再安装进既有 Context/迁移存储；描述加载包的迁移当前信任也直接复用受检 Registry，不再要求第二个重复的宿主信任回调。外部 MCP Profile、Scenario Process 启动权限和模型配置仍必须由宿主提供，因为它们包含部署凭据、可执行环境和权限，不应由场景包自行决定。

因此，当前可以称为“底座仓库实现可供场景接入”，但不能称为“全平台生产发布已经验收”。真实模型联调、Linux 协议 2 的 19 类实机矩阵、Windows stdio/ConPTY 双模式、真实能力 Observer 和用户暂缓的 24/72 小时长稳仍是外部验收项。

## 真实调用链核对

| 链路 | 实际状态 | 结论 |
| --- | --- | --- |
| Scenario → Core | `ScenarioPackageRegistry` 提供开放身份、Definition、精确版本绑定、声明式授权和输出合同；通用 Foundation/Runtime 不 import 具体 Scenario | 仓库实现完成 |
| Package 材料 → 运行 | `scenario.json`、材料 manifest、审核签名、当前 trust、Extension Assembly、宿主 launch 摘要和进程握手逐层绑定 | 仓库实现完成；分发器/商店不在当前范围 |
| Skill / Knowledge → 模型上下文 | 当前受信本地正文自动安装；外部 MCP 资料按精确 Profile 和 Package 绑定按需读取；Gateway 回执与快照保留来源 | 仓库实现完成 |
| Tool / MCP / Provider → 执行 | Discovery → Gateway → 当前 Scope/Approval → 本机 Execution Node/Host Broker → Receipt/Checkpoint；未知副作用不自动重放 | 仓库实现完成；具体外部服务仍需部署配置 |
| Scenario Process → Host 能力 | Package/Case/Run/Work 归属由 Host 注入，能力回执持久化，撤销和 generation 变化在使用时复检 | 仓库实现完成 |
| 重启 / 容量 / 恢复 | 调用、进程、Provider、装配、Run 历史、备份和候选切换均有账本、边界拒绝和选定强杀回归 | 仓库实现完成；真实断电和长稳未验收 |
| Runtime 可复用边界 | `agent-runtime`、`cognitive-runtime`、`model-runtime` 等无 Fastify/SQLite 测试宿主已存在；Server 仍保留大量 Adapter、持久化和组合代码 | 不阻止场景接入；后续只按稳定端口继续提取，不机械拆包 |

## 场景接入后的边界复核

- `apps/server/src/main.ts` 已不再 import、构造或默认安装 Web 黑盒包，也不再绑定 Web Session/Traffic 能力；它只读取 `config/scenarios.json` 中的通用审核安装和本机启动 Profile，缺省为空 Registry。旧 `McpManager` 仍是应用兼容路径，后续只在真实场景需要时按 Package Profile 迁移，不能成为全局能力旁路。
- Web Browser 强制代理、Web 专属 Prompt/知识、资产探索策略、白盒 AST/污点能力、红队横向工具和 UI 均属于后续 Scenario/Application。
- 多用户、租户、远程 Execution Node、多主机调度和桌面自动更新已明确排除或暂缓，不作为底座完成缺口。
- Package 下载、上传市场和自动更新不是安全运行主链的前置条件；首批场景可由受信本机安装目录交付，后续若有真实分发需求再设计原子安装与签名轮换。

## 进入下一阶段的条件

仓库代码继续以 `verify:foundation`、Scenario/Core import 边界、零场景构建、中性 Package fixture 和故障回归为强制门禁。首个 Web 黑盒包已经只靠描述文件、运行进程、Skill/Knowledge 和宿主启动配置接入；新增的 HTTP 接口是 Execution Node 已有受控网络执行能力的通用 Scenario Process 桥接，不包含 Web 状态码、漏洞或目标规则。任何后续缺口仍只有在能证明被多个场景共同需要时才回补底座。

通俗地说：底座现在已经把“场景说明书、知识、工具、权限、执行沙箱、账本和恢复”接成一条路，Web 黑盒也已作为第一件可替换设备插上去。底座只提供通用的受控网络请求，URL 范围和调查方法留在场景包；后续继续扩充 Web 场景时，若必须把漏洞类型、状态码或某个工具名称写回 Core，接入就应停止并修正抽象。
