# 数据化 Scenario Package 加载

更新日期：2026-09-03。该能力属于通用安全智能体底座，不包含任何具体安全场景、应用 UI、远程节点或扩展商店。

## 目标和目录合同

生产场景包可以用 `traceforge.scenario-package.v1` 的 `scenario.json` 表达 Package 身份、Scenario Definition、声明式 Scope Policy、Output/Evidence 合同、Skill/Knowledge/MCP 资源引用和 Scenario Process 清单。一个最小目录形态是：

```text
package-root/
├── scenario.json
└── runtime/
    └── main.mjs
```

`scenario.json` 必须作为 `traceforge.scenario-material.v1` 的 `data` 文件列出；Scenario Process 的 `package://` 入口必须精确对应材料清单唯一的 `entry` 文件。本地 Skill、Knowledge 和迁移资源也必须使用 `package://`，对应一个摘要相同的 `data` 文件。审核通过的本地文本会自动进入既有 Context/迁移存储，不再要求宿主重复提供正文；外部 MCP Context 仍由已有精确 Profile、Package 绑定和撤销门禁管理。

## 加载与信任顺序

`loadScenarioPackageDescriptors` 只读取固定名称的 JSON 数据：真实绝对根目录、非符号链接、`O_NOFOLLOW`、清单字节数和 SHA-256 全部匹配后才解析。解析器限制 1 MiB、32 层递归和各集合容量，逐层拒绝未知字段，禁止回调、表达式和不安全 `package://` 路径；加载器随后用 Registry 做 Definition、输出、资源和迁移引用检查。返回对象及全部子对象被冻结。

加载本身不授予信任。Foundation 的 `loadScenarioPackageDescriptors` 开关会把同一批 `scenarioPackageTrust.installations` 先构造成 Registry，再立即进入已有材料签名、签发者、有效期、不可变登记、当前字节和撤销复检。官方加载器在内存中保存对象与精确根目录、材料摘要、描述文件摘要的不可伪回写关联，因此数据化包不再要求宿主手写 `assertAssembly`；手工构造的旧 Package 对象仍必须由可信宿主显式关联。

单个版本只有在描述文件、材料、审核和当前信任都成立后才可用。失败版本保持 `recovery_required`，不会启动进程、读取资源或进入模型上下文；后续恢复信任时每次使用仍复检声明式合同。重复 Package/Definition、描述身份与审核身份不一致、入口/资源未声明、文件替换或符号链接均 fail closed。

## 权限边界

描述文件不能选择宿主可执行程序、工作目录、环境变量、文件/网络权限、资源限额、沙箱后端或服务归属。这些仍由可信宿主的 `scenarioProcessLaunches` 提供，并由 Extension Assembly 固定摘要、Execution Node 实际启动证明和 Scenario Process 握手共同复检。数据化加载不会 import `scenario.json` 或运行目录中的 JavaScript；唯一可执行入口只能在 Package 可用后由本机 Execution Node 送入原生沙箱。

应用组合根现在从 `config/scenarios.json` 读取受信安装、审核公钥和本机 Scenario Process 启动 Profile；文件不存在时以零场景启动。配置只决定宿主部署材料，不会执行 Package 代码。`pnpm scenario:package -- --source <绝对源码目录> --output <全新绝对输出目录> --private-key <Ed25519 私钥> --key-id <审核者> --review-ref <审核记录> --expires-at <ISO 时间>` 可把描述文件、进程入口及其本地资源复制到独立不可变目录，生成材料清单、审核签名和可并入宿主配置的 sidecar；私钥不进入 Package 或仓库。

该能力不是下载器、上传接口、包市场、自动更新或跨机器分发。签名轮换、混合可执行资产传输和应用侧目录选择 UI 仍未实现；当前本机交付路径已经足够让场景无需修改 Core 或编写宿主内装配代码进入既有安全主链。

## 验证口径

中性回归覆盖纯数据构造、深冻结、未知/回调字段、描述与材料路径逃逸、严格 UTF-8、描述文件替换与符号链接、Package 身份错配、
本地资源未列入材料、正文加载后篡改、Skill/Knowledge 与迁移正文自动装配、无需手写关联的签名信任，以及 Foundation 中失信版本只隔离不启动。
首个 Web 黑盒包已用该链路完成签名配置装配测试，并以独立进程穿过授权与通用受控 HTTP、Artifact、State 和 Evidence 能力；其结构化探索实现见 [Web 黑盒 Scenario Package](web-blackbox-scenario.md)。测试不代表真实模型、完整漏洞验证策略、Linux 协议 2 或 Windows 原生沙箱已经完成外部验收。
