# 单用户宿主的管理与 Worker 通道

## 范围与实际保证

这是同一个用户下**程序调用来源的隔离**，不是账号、登录、租户、组织或多用户权限平台。
`actor`、`approvedBy`、Case/Run/workerId/leaseId 都不是通道凭据。
单纯知道本机服务地址、当前任务身份或可信 UI Origin，不能调用管理操作。

生产 Foundation 安装 `FoundationHostControl`，为可信宿主签发独立的管理通道和 Worker 通道。
新 API 默认归管理通道，Worker 仅有显式允许的控制面操作。
内置 Worker 已使用受控传输；模型上下文、工具执行上下文、Provider 参数、SQLite 和检查点不接收这些凭据。
真实工具尝试使用自己持有的 workerId/leaseId 暂停 Run 的端到端测试被拒绝。

这里仍不是任意同进程 JavaScript 沙箱。可信插件若已取得应用实例、内存、宿主对象或任意系统能力，
无法通过本机制证明它被隔离；宿主代码、路由处理器及钩子仍须受信。
OS 沙箱验收、可信清理签发、独立进程隔离的缺口不因增加 HTTP 凭据而消失。

## 生产接线与迁移

组合顺序必须先安装 Foundation 通道门禁，再注册其他 API。
`main.ts` 已调整接线顺序，使旧应用 API 与 `/ws` 同样受门禁约束，不留下匿名配置/Case 接口旁路。
注册在门禁之前的任意外部路由不属于支持的宿主装配方式；低层 route 注册函数自身不等于完整生产组合根。
嵌入方调用 `registerSecurityAgentFoundation` 后，可以通过可信进程内 API 获取：

```ts
const hostControl = foundationHostControl(app);
const management = hostControl.management();
// app.listen 完成后，由可信宿主发起请求；不是交给模型的工具。
const response = await management.fetch(`${baseUrl}/api/scenarios/definitions`);
// 接入方生命周期结束时：
management.revoke();
```

没有 HTTP 领票接口，没有“本机免验证”模式，也不接受旧匿名 API 自动降级。
`headers()` 仅用于可信宿主需要自行组装传输的场合；不要把返回值写入 URL、日志、项目文件、模型提示或工具环境。
测试宿主已迁移到真实管理通道，不是关闭门禁来保持测试通过。

**兼容变化**：旧前端、curl 或外部 Worker 的匿名 API 请求将收到 401；取得了 Worker 通道但调用管理 API 会收到 403。
既有前端及桌面 UI 尚未增加受信宿主桥接，仍按用户要求冻结；可加载静态页面不等于旧 UI 已能操作受保护 API。
本批交付的是底座传输契约与宿主 API，不宣称桌面端到端交互已验收。
未来 UI 只能通过受信宿主桥接使用管理能力，不能增加向任意网页/工具公开发放凭据的端点。

## 通道权限

| 通道 | 可用入口 | 独立校验 |
| --- | --- | --- |
| 匿名 | GET `/api/health`、非 API 静态内容；不存在的路由保持 404 | 没有管理副作用；生产原 Origin 规则仍生效 |
| 管理 | 已注册 `/api/**` 和 `/ws` | 原业务授权、审批、签名证明和数据边界继续校验 |
| Worker | 固定 Worker 注册、自己的 heartbeat/assignments、renew/checkpoint/complete/request-approval/fail/block | 宿主固定描述符、定义版本、当前 Run/Work/Worker lease |

Worker 不能创建授权、决定审批、暂停/恢复任务、释放未知执行占用、变更 Provider 或查看管理诊断。
注册时固定 id、roles、capabilities、maxConcurrentWork 和 status，额外字段或改写均拒绝；
这些 roles 是既有智能体执行角色，不是多用户角色管理。
Work 命令必须属于当前运行中的 Run，精确匹配 Work/workerId/leaseId、未过期租约和宿主固定的定义版本。
任务取消后旧租约失效，Worker 通道本身仍可获取后续合法分配，不能操作已取消的旧 Work。
assignments 不允许因重复 Worker id 泄漏不同定义版本的任务。

通道凭据并不能代替业务授权。例如管理通道调用清理 API，仍必须通过独立 authorizer 和可信清理证明，
不会仅凭持有管理通道就把未知占用清空。

## 凭据与生命周期

- 每个凭据为随机 256 位能力票据，使用 `Authorization: Bearer ...` 传输；服务端按 SHA-256 摘要查询。
- 只接受精确格式和单个 Authorization 头；不从 query、cookie、Origin、actor 或正文提取凭据。
- 默认有效期一小时，可构造 1 毫秒至 24 小时的有界期限；可信宿主持有的通道会在下次使用时换票。
  复制出去的旧 wire token 不能换票；轮换、revoke 和 Worker 替换后旧票拒绝。
- 凭据只在内存，没有默认配置文件、环境变量、HTTP 导出或持久化恢复。
  宿主关闭清空并撤销所有通道，新宿主生成新票，旧票不能随 SQLite 恢复而复活。
- 总活动票据最多 1,024，管理票据最多 8；Worker 通道绑定数量也有 1,024 上限。撤销释放槽位。
- 池缩容、停止和启动失败撤销对应 Worker 通道；同 Worker 的新通道替换旧通道。
- 请求进入时校验票据；解析正文后，以及路由钩子结束、真正调用处理器前，再检查到期/撤销及 Worker 所有权。
  不保证撤销已经进入业务处理器的事务或已经发送的外部副作用；它们继续由业务生命周期/授权提交围栏负责。

## 传输边界与诊断

受保护接口仅接受真实 socket 的 loopback 来源，不信任 X-Forwarded-For，也不支持远程明文管理。
宿主通道的 fetch 只把凭据发往当前 app 对应的 `http://127.0.0.1:port`，拒绝其他 origin、URL 用户信息和重定向。
反向代理后的本机连接不能自动证明远端调用者身份，因此不把这个组合当成远程管理部署方案。
`TRACEFORGE_HOST` 即使监听外部地址，也不代表受保护 API 支持远程访问。

`GET /api/security-tools/host-channels` 仅管理通道可读，返回模式、有效期、活动数量、关闭状态及明确的非 JS 沙箱标记。
不返回票据、摘要、角色配置或管理者身份。健康检查不泄漏票据。

## 验证

集成回归覆盖匿名/Worker 管理拒绝、伪造头/重复头/query/cookie/actor 拒绝、注册能力固定、精确 Work/定义/租约、
撤销/过期/等待期间状态变化、重启与换票、容量、loopback/转发/重定向拒绝、实际 Worker HTTP 传输，
以及真实生产工具越界请求和正常模型/工具执行机制。另有 main 接线回归，保证旧应用 API 没有绕开门禁。
原 Scope/审批/签名证据、取消与恢复回归仍一起执行；离线模型夹具不能替代真实模型与多日长稳验收。
当前完整基线见 `docs/development-status-and-roadmap.md` 第 6 节。
