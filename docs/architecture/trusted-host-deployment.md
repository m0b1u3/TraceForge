# 受信宿主部署清单、预检与整代回退

## 目标

TraceForge 的数据库恢复候选已经可以通过独立活动指针切换，但数据库只是宿主状态的一部分。生产执行还依赖底座二进制、
Schema、原生沙箱 Helper、签发根、Scenario、Skill、知识资源、MCP/Provider、模型配置、容量策略和恢复目录身份。
如果这些材料分别升级，宿主可能进入“代码是新版本、信任根还是旧版本、数据库迁移只做了一半”的状态。

`FoundationDeploymentControl` 为这些依赖建立一个不含秘密的、可审计的整代部署边界：

```text
reviewed release manifest
        │
        ├── foundation / database schema / native helper
        ├── trust roots / scenario packages
        ├── skills / knowledge resources
        ├── MCP providers / model configuration
        ├── capacity policy / recovery identity
        └── host-secret:// references (reference only)
        │
        ↓
immutable staged release + READY digest
        │
        ↓
exact current-material preflight
        │
        ↓
independent authorization + pinned plan
        │
        ↓
atomic ACTIVE.json replacement
        │
        ↓
startup preflight before DB open, MCP, model and Execution Node
```

## 清单不保存秘密

Manifest 只允许有界、严格 Schema。组件用 `kind + id + version + sha256 digest` 标识；凭据只能以
`host-secret://...` 引用出现。实际 API key、Vault key、私钥和 Token 由受信宿主持有，不进入发布文件、HTTP、模型上下文或审计正文。

每份清单必须显式覆盖以下类别：

- `foundation`
- `database_schema`
- `native_helper`
- `trust_root`
- `scenario_package`
- `skill`
- `knowledge_resource`
- `mcp_provider`
- `model_configuration`
- `capacity_policy`
- `recovery_identity`

数据库组件必须唯一，并与 migration 的目标 Schema revision 完全一致。相同类别和 ID 不能重复。

## 启动门禁

只要配置了 Deployment Control，缺少活动 manifest 就拒绝启动。生产 `buildServer()` 的顺序是：

1. 解析恢复候选活动数据库；
2. 解析 Deployment `ACTIVE.json`；
3. 调用受信宿主 inventory adapter 重新计算当前材料；
4. 对 required 缺件、未知额外组件、版本或摘要漂移、缺失 secret reference 做有界报告；
5. 任何差异都在打开或迁移数据库之前抛错；
6. 只有通过后才创建数据库、连接 MCP、初始化模型、装配 Scenario 和启动 Execution Node。

Inventory adapter 是受信宿主边界。它必须对 `buildServer` 实际使用的文件、配置和目录做摘要，不能返回未经检查的 manifest 副本。
Core 不读取秘密，只验证宿主报告的引用集合和非秘密材料身份。

## 升级与回退

`stage` 把经过审核的 manifest 写入独立私有目录，使用 `manifest.json + READY` 固定内容身份。release ID 和 deployment generation
全局唯一，活动部署之后的新升级必须按连续 generation 前进，数据库 migration chain 也必须连续。

`activate` 和 `rollback` 均采用：

- 当前 switch generation；
- 目标 release、deployment generation 和 manifest digest；
- 当前材料 preflight digest；
- migration 信息；
- 完整 plan fingerprint；
- 独立、带截止时间的授权。

活动指针通过同目录临时文件、fsync 和 rename 原子替换。回退只允许紧邻的上一份活动 release；如果当前升级未声明
`rollbackCompatible`，或旧 release 的 Schema 不是当前 migration 的来源 revision，则拒绝回退。切换只改变受信宿主选择，
不会自动恢复暂停 Run，也不会重放外部动作。

## 崩溃一致性

操作请求和阶段事件保存在独立可写审计数据库，并禁止 UPDATE/DELETE。真实 SIGKILL 回归覆盖：

- staged release 已发布、终态审计未落；
- switch intent 已落、活动指针未替换；
- 活动指针已替换、终态审计未落；
- 操作已完成后客户端未收到结果。

重试必须使用完全相同的 command 和 plan。恢复逻辑以已 fsync 的 release/pointer 为事实来源，只补缺失审计，不重复发布、不再次增加
switch generation。相同 command 使用不同正文会被视为冲突。

## 明确边界

- Core 提供不可变发布、精确预检、原子选择和恢复协议，不负责下载二进制或保存凭据。
- 宿主安装器必须把每代实际文件保存在可按 manifest 检查的位置，并确保 inventory adapter 检查的正是生产将使用的材料。
- `ACTIVE.json` 依赖受信宿主和 OS 私有目录权限，不防御已经取得同一 OS 账号写权限的攻击者。
- 当前测试覆盖真实进程 SIGKILL；真实断电、跨卷 rename、Windows ACL/锁语义、签发根轮换和长时间运行仍需独立部署验收。
- 未配置 Deployment Control 时保留开发模式兼容性；这不代表未托管宿主满足生产发布门槛。
