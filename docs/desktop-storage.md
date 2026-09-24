# 桌面本地存储

2026-09-21。存储管理属于桌面宿主，不依赖具体 Scenario，不改变模型配置或执行授权。

## 目录与生命周期

macOS 新安装默认使用以下位置：

| 内容 | 正式版 | 开发版 |
| --- | --- | --- |
| 持久应用数据 | `~/Library/Application Support/TraceForge/` | `~/Library/Application Support/TraceForge-Dev/` |
| 诊断日志 | `~/Library/Logs/TraceForge/` | `~/Library/Logs/TraceForge-Dev/` |
| 界面 HTTP 缓存 | `~/Library/Caches/TraceForge/` | `~/Library/Caches/TraceForge-Dev/` |

隔离验收在导入桌面入口前显式设置 `userData`，日志和缓存也留在该隔离根内，不触及常用账户。非 macOS 使用平台 appData 下的固定应用根，日志与缓存为对应子目录；尚未因此宣称 Windows/Linux 原生验收通过。

既有 `config/llm.json`、`config/*.bin`、`traceforge.sqlite`、`data/run-workspaces/` 及其他持久文件**不搬动、不重排、不删除**。开发启动识别旧 `@traceforge/desktop` 或 Electron 数据根中明确的 TraceForge 数据标记，继续使用原根，并在设置中说明；如果新旧两个根都存在独立数据，则拒绝自动合并，提示先备份处理。正式版不自动导入开发版数据。路径选择不改变 Electron 应用名称，避免影响现有系统加密身份。

`userData` 与 `sessionData` 都在 ready 之前设置。Chromium 的持久 Cookie/profile 留在持久数据根，HTTP 磁盘缓存单独指定目录。

## 设置 → 数据与日志

- 读取应用数据、诊断日志的文件字节总量；不跟随符号链接，遇到无法统计的文件明确显示“部分目录未计入”。这是文件字节统计，不是磁盘块实际占用，也不是即时配额。
- HTTP 缓存用量由当前 Electron session 提供，不冒充整个缓存目录占用。
- 打开数据/日志目录只接受固定操作名，路径由宿主决定；不开放任意文件系统操作。
- 清理仅调用当前界面 session 的 `clearCache()`。不调用 `clearStorageData()`，不清 Cookie、模型令牌、数据库、证据、对话目录或独立任务浏览器，不停止模型。
- 请求绑定主窗口主框架和本地页面；忙时不重复执行。失败不自动重试删除或其他写操作。

## 诊断日志与证据分开

`desktop.jsonl` 记录启动、就绪、退出、渲染进程异常、清理结果及本地 Server 的数值级别/响应状态/耗时。采用字段白名单，不落盘原始 Pino 文本、URL、请求头、请求正文、模型对话、Cookie 或异常堆栈。当前属于最小运行诊断，不是完整调用追踪；不能把它当作工具执行证据。

单文件达到 10 MiB 后轮换，保留 5 个旧文件；只操作自有命名文件。写入失败可在设置读取，日志不可写不终止任务。该容量只作用于诊断日志，**不限制模型输出、执行回合或证据保存**。会话、回执、证据仍由现有持久层管理，不能随日志清理。

凭据继续使用已有操作系统支持的加密存储；本次不迁移密钥、不新增明文导出、不提供自动上传诊断。

## 验证

- 单元/组件测试：稳定路径、开发/正式/隔离分离、旧数据沿用、冲突拒绝、符号链接、日志轮换与字段过滤、IPC 主框架约束、明确清缓存、失败与重复点击。
- `scripts/verify-desktop-storage.mjs`：真实 Electron preload → IPC → session 缓存 API，检查 Cookie、配置与数据库夹具保留；不使用真实密钥或模型。
- 界面截图使用合成数据，不作为真实任务浏览器接管验收。

后续需要时再提供显式的数据迁移/备份选择器；当前不自动合并多个历史根，不删除旧 Chromium 缓存目录。此项不会阻塞既有单根数据正常使用。
