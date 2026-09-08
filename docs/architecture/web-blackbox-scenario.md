# Web 黑盒 Scenario Package

更新日期：2026-09-09；当前 Package 版本：0.5.6

0.5.6 补齐 HTTP/Session/Surface 的有界优先观测摘要；`interestTerms` 来自调用方及可编辑指导，不内置漏洞错误词典。通用宿主按当前授权与来源有效性投影最多 8 张、每张 600 字符的当前 Run 线索卡，场景指导模型用已有图工具写入，卡片是不可信观测而非指令或已验证结论。失效/撤销/替代的卡退出投影，原始审计图不删除。

各阶段与 Worker pool 声明 `tool.recall`，新授权显式允许当前 Run 的回执命名空间、读取角色以及本场景/内置工具来源；宿主保留原始归属、来源合同、撤销与 Worker 自身 Work 读取限制，不重发原操作。旧 Run 继续绑定原包，不隐式扩大授权。压缩时 recall 使用实际摘要文本预算的最多三分之一（最高 8000 字符），普通摘要使用剩余额度；线索卡和其他保护字段仍受整体 JSON 上限约束。此实现不是无限记忆，也不是免截断的异常全文通道。

## 边界

Web 黑盒是 `scenarios/web-blackbox` 中的独立场景包，不是 Core 或 Foundation 的内置模式。Package 用纯数据描述身份、阶段、Worker 能力、Scope、输出合同、Skill、Knowledge 和进程入口；工具正文只在本机 Scenario Process 中运行。应用缺少受信安装配置时仍以零场景启动。

底座只提供领域无关的授权、受控执行、Artifact、State、Evidence、Session 和 Traffic 端口。只有 Package 声明 Session/Traffic 能力时宿主才装配对应 Adapter；底座不认识登录页、表单或任何 Web 业务语义。URL 规范化、同源判断、HTML 链接发现、探索队列、HTTP 摘要及 Web 证据字段全部留在本包。Scope 可给出精确 `targets`，也可给出已经规范化且以 `/` 结尾的 `urlPrefixes`；底座对后者只执行显式词法前缀匹配，不推断域名或路径边界。

## 当前执行链

0.5.5 增加同一假设内有界 `candidates` 矩阵（最多 16 个顺序变体），绑定预期信号与停止条件，保留旧单 candidate 合同。每个变体重复配对基线，逐请求授权/回执/检查点，未知结果不重发。预算由授权表单声明、运行时从 Scope 读取；累计 HTTP admission 使用 Run 状态，跨调用及子进程重启不清零。默认访问上限仍 64，可明确授权至 512；假设默认 16、最高 128。累计额度不覆盖 Browser 子资源或公开资料工具。通用请示、历史读取和上下文保留见当前开发计划“六项架构优化”。下述固定数字在 0.5.5 指默认值或未参数化的独立保留上限。

`web.http.request` 用于单次有界请求。`web.surface.explore` 用于结构化探索：

1. 规范化 HTTP(S) seed，删除 fragment，并拒绝 URL 内凭据；
2. 从 Package 私有 State 读取 `web.surface.v1`，合并并去重 seed 与待处理队列；
3. 每个 URL 在请求前单独做 `network.url` 授权，只通过通用 Execution Host Capability 发起 GET；
4. 仅对 HTML/XHTML 提取有界静态链接提示，只把 seed 同源链接加入后续队列；表单单独保留动作/方法/字段名与类型，不保留字段值、不提交表单、不把 action 自动转成 GET；外部 origin 只记录；
5. 为响应摘要记录 Artifact，把正文 SHA-256、截断状态和 Network Receipt 关联到 Evidence；
6. 每处理一个 URL 就以 revision compare-and-set 保存队列、已访问集合和观察结果。进程退出后，新进程可从 Host 状态继续。

探索单次最多 8 个请求、16 个 seed、每页 64 个候选链接和 1 MiB 响应；持久状态最多保留 32 个待处理 URL、64 个已访问 URL、16 个观察及 16 个跳过项。64 个已访问地址不再滚动淘汰，到上限即停止派发，避免循环抓取。工件只保存最多 1,024 字节正文摘要、8 个同源地址和 8 个外部 origin；表单提示最多 8 个表单/每表单 16 个字段，总 JSON 另限 4 KiB。响应正文不复制进 Package State。状态另有 192 KiB 字节预算，移除旧观察时累计 omissions；达到请求/访问预算返回明确标记、剩余队列和恢复 revision，不能把截断伪装为完整覆盖。

`web.surface.catalog.v1` 记录最多 16 个匿名/Session 库，首次探索在发包前登记；并发登记遵循 CAS，冲突不发包。`web.investigation.snapshot` 和 `web.report.build` 只读这些库存及候选账本，报告匿名/会话覆盖、排队、遗漏和未知效果；读取不扩权、不调度、不清除未知效果。旧的未登记库存可能不完整，因此输出保留历史覆盖限制。

`web.hypothesis.register` 把每个候选固定到保留观察和来源库存；`web.validation.execute` 绑定原 Work/计划，最多四次一次性准备后执行两至三轮 GET/HEAD 对照。未知探索效果也会阻止新验证派发。`web.validation.review` 的 supported/refuted 必须同时引用 baseline 和 candidate；差异和审阅意见不会自动产生 verified Finding。

调查 snapshot 返回建议动作及原 Work ID、排队候选、未知候选/库存。它只是 Scenario 提供的交接数据；Core 仍负责单个验证 Work 并发限制和阶段转换。场景内容拆成调查规划、验证方法、复核报告三份 phase-local playbook，加上 HTTP 操作 Skill、证据标准与黑盒技巧两份 Knowledge（后者覆盖指纹识别、JavaScript 接口资产分析、未授权/注入探针、业务逻辑假设违反，并写死禁止大规模爆破、仅允许绑定单一假设的小范围 fuzz），通过受审查资源清单装配给 Worker/Planner/Observer；后两者消费结果或提出 Work，不伪装自己调用 Worker 工具。

Web `0.3.0` 同时提供受控认证链：`web.session.catalog` 只列出当前 Scope 明确允许的身份描述符；`web.session.open` 把会话固定到 Case、Run、Scope 和当前执行租约；`web.session.request` 只提交 Session/秘密句柄，不提交秘密值。身份材料由本机 Vault 使用 AES-GCM 加密保存，秘密头只注入身份登记的 URL 前缀，Cookie 按 domain/path/secure/expiry 匹配。登录表单或 JSON 可引用命名秘密，由 Host 在边界内构造真实正文；文本响应的短期 token 可用最多 16 个精确起止分隔符捕获并加密回写，进程只收到捕获名称。响应 `Set-Cookie` 进入 Cookie Jar，不返回场景进程。

每次认证请求继续经过逐 URL 授权和本机 Execution Node，并生成 Network Receipt。Traffic 绑定当前 Case/Run 和所用身份版本：秘密请求头只记录 `present/redacted`，秘密模板只记录句柄，普通正文只记录 SHA-256，响应移除 `Set-Cookie` 并替换已知秘密；场景只能通过 `web.traffic.snapshot` 读取当前 Run 的有界脱敏记录。身份撤销、身份版本变化、Run/Scope 失效、Session 到期或租约转移都会冻结使用，同一 Session 不能同时借给另一个有效租约。

## 尚未实现

- 任意 JavaScript 计算型登录、OAuth/OIDC 重定向编排、MFA 和人工接管尚未实现；当前短期 token 只支持有界精确分隔符捕获；
- `web.browser.inspect/read` 已提供观察与保留工件读取，必须有受信本地 Browser 部署；这不等于可交互登录、任意浏览器动作或动态页面覆盖已闭环；
- 任意多步业务状态机、每轮重置、请求正文对照与任意漏洞利用程序不属于当前有界 HTTP 对照执行器能力；
- 报告构建器不自动读取或推进 Finding 生命周期，仍需现有图工具与审阅；浏览器/手工请求不自动进入 HTTP 探索库存；
- 真实模型调查效果和 macOS 桌面全链路由后续手动验收确认；Linux 后续单独测试，不能以本机夹具通过替代。

真实效果验收按[手动验收清单](../web-blackbox-manual-acceptance.md)，使用重新审核安装的 0.5.6 场景包完成桌面调查；当前开发优先级以开发计划顶部的工具使用闭环为准。保留旧 Run 的原版本绑定，不覆盖旧版本的受信文件或伪造迁移。0.5.1 为各阶段和 Worker pool 声明上下文读取能力，资源授权仅允许包内列出的指导资源；用户资料由宿主配置层继承读取边界，不将场景策略写入底座。

通俗作用：这批让智能体能看到入口线索、记住不同身份下探索到了哪里、知道哪个候选还在验证，并交出不隐藏遗漏的报告；这些逻辑已经有本地回归，但真实模型是否能独立完成具体调查，仍要由后续手动测试证明。
