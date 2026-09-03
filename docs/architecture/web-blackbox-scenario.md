# Web 黑盒 Scenario Package

更新日期：2026-09-03

## 边界

Web 黑盒是 `scenarios/web-blackbox` 中的独立场景包，不是 Core 或 Foundation 的内置模式。Package 用纯数据描述身份、阶段、Worker 能力、Scope、输出合同、Skill、Knowledge 和进程入口；工具正文只在本机 Scenario Process 中运行。应用缺少受信安装配置时仍以零场景启动。

底座只提供领域无关的授权、受控执行、Artifact、State、Evidence、Session 和 Traffic 端口。只有 Package 声明 Session/Traffic 能力时宿主才装配对应 Adapter；底座不认识登录页、表单或任何 Web 业务语义。URL 规范化、同源判断、HTML 链接发现、探索队列、HTTP 摘要及 Web 证据字段全部留在本包。Scope 可给出精确 `targets`，也可给出已经规范化且以 `/` 结尾的 `urlPrefixes`；底座对后者只执行显式词法前缀匹配，不推断域名或路径边界。

## 当前执行链

`web.http.request` 用于单次有界请求。`web.surface.explore` 用于结构化探索：

1. 规范化 HTTP(S) seed，删除 fragment，并拒绝 URL 内凭据；
2. 从 Package 私有 State 读取 `web.surface.v1`，合并并去重 seed 与待处理队列；
3. 每个 URL 在请求前单独做 `network.url` 授权，只通过通用 Execution Host Capability 发起 GET；
4. 仅对 HTML/XHTML 提取 `href/src/action`，只把 seed 同源地址加入后续队列，外部 origin 只作为观察记录；
5. 为响应摘要记录 Artifact，把正文 SHA-256、截断状态和 Network Receipt 关联到 Evidence；
6. 每处理一个 URL 就以 revision compare-and-set 保存队列、已访问集合和观察结果。进程退出后，新进程可从 Host 状态继续。

探索单次最多 8 个请求、16 个 seed、每页 64 个候选链接和 1 MiB 响应；持久状态最多保留 32 个待处理 URL、64 个已访问 URL、16 个观察及 16 个跳过项。工件只保存最多 1,024 字符正文摘要、8 个同源地址和 8 个外部 origin；响应正文仍由网络回执指向，不复制进 Package State。达到预算时返回明确的 `budgetExhausted`、剩余队列和恢复 revision。

Web `0.3.0` 同时提供受控认证链：`web.session.catalog` 只列出当前 Scope 明确允许的身份描述符；`web.session.open` 把会话固定到 Case、Run、Scope 和当前执行租约；`web.session.request` 只提交 Session/秘密句柄，不提交秘密值。身份材料由本机 Vault 使用 AES-GCM 加密保存，秘密头只注入身份登记的 URL 前缀，Cookie 按 domain/path/secure/expiry 匹配。登录表单或 JSON 可引用命名秘密，由 Host 在边界内构造真实正文；文本响应的短期 token 可用最多 16 个精确起止分隔符捕获并加密回写，进程只收到捕获名称。响应 `Set-Cookie` 进入 Cookie Jar，不返回场景进程。

每次认证请求继续经过逐 URL 授权和本机 Execution Node，并生成 Network Receipt。Traffic 绑定当前 Case/Run 和所用身份版本：秘密请求头只记录 `present/redacted`，秘密模板只记录句柄，普通正文只记录 SHA-256，响应移除 `Set-Cookie` 并替换已知秘密；场景只能通过 `web.traffic.snapshot` 读取当前 Run 的有界脱敏记录。身份撤销、身份版本变化、Run/Scope 失效、Session 到期或租约转移都会冻结使用，同一 Session 不能同时借给另一个有效租约。

## 尚未实现

- 任意 JavaScript 计算型登录、OAuth/OIDC 重定向编排、MFA 和人工接管尚未实现；当前短期 token 只支持有界精确分隔符捕获；
- Browser、DOM、截图、下载、弹窗、WebSocket 和 Service Worker 仍关闭；
- 参数关系、业务流程状态机、独立 Hypothesis 生成和因果验证矩阵尚未闭环；
- 真实模型效果、多个授权测试应用、24/72 小时稳定性和 Windows 原生沙箱仍未验收。

下一里程碑是把探索结果组织成**业务流程与身份差异模型，并形成单任务因果验证闭环**：在包内关联端点、参数、页面状态、身份和前后置请求；Research Worker 保留多个独立候选，Validation Worker 每次只执行一个基线/变量对照并把结果写入证据链，不把一次异常响应直接升级成 Finding。

通俗作用：现在智能体已经能安全使用你预先保存的账号检查内网页面，密码和 Cookie 不用交给模型。下一步要让它不再只看一张张孤立页面，而是理解“登录 → 查看 → 修改”这样的连续流程，并能比较不同受控身份在同一动作上的结果；只有差异可重复、原因明确且影响成立，才进入漏洞结论。
