# 本机原生 Execution Node 信任边界

## Linux 原生 helper 已实现的部分

Execution Node 协议为 1.8。Linux 进程后端不接受通用 `spawn` 或 Bubblewrap 名称作为生产证明；宿主只识别显式配置或随发布清单安装的 `traceforge-linux-sandbox`。仓库现已包含 Rust helper 源码。它使用 `clone3(CLONE_INTO_CGROUP)` 在目标执行任何代码以前原子进入受委派 cgroup v2，并创建独立 user、mount、pid、ipc、uts、network namespace；以 tmpfs 新根、显式 bind mount、递归 mount attributes、deny mask 和 `pivot_root` 实施文件可见范围；安装 `no_new_privileges` 与 seccomp，清除 capability，并阻止目标清除 helper-death signal 或调用新旧 mount API 改写边界。

当前 helper 协议 2 只支持 `deny` 进程网络：新的 network namespace 没有宿主接口，也不把“brokered/direct 以后可以做”谎报为 helper 已支持。它同时提供 stdio 和 framed PTY；PTY 的输入、调窗、关闭输入、终止确认、输出、资源超限和带启动 nonce 的完成消息，全部复用同一组 namespace、文件权限、cgroup、seccomp、资源监督和空进程树屏障，不存在普通 `spawn` 或弱隔离终端回退。目标程序只收到请求中明确给出的环境变量；宿主的 `LD_PRELOAD`、代理、凭据等环境不会直接继承。CPU 总量、内存、进程数与 cgroup 写 I/O 计数由 helper 监督，越界后调用 `cgroup.kill`；根进程退出也必须杀净并观察 `pids.current == 0` 才结束。状态文件在派生目标前以 `create_new` 建立，资源终止原因不从目标 stdout/stderr 猜测。

Helper 的 `probe` 会实际运行一次同样的 namespace/cgroup/seccomp 隔离路径。宿主要求显式的 `TRACEFORGE_LINUX_CGROUP_ROOT` 指向已委派 cgroup v2 目录，并为每个桌面数据根使用私有 scratch；探针失败、目录未配置、内核缺 `clone3`/`mount_setattr`/`cgroup.kill` 或 helper 缺失时，进程能力保持关闭，没有弱模式回退。

探测通过后，宿主记录 Helper 可执行文件的 SHA-256，并把该 measurement 放入节点能力描述。每次真正启动前重新读取文件并核对摘要；文件在启动后被替换时直接拒绝执行。Launcher 返回的 enforcement 也必须携带相同 measurement、权限 Profile 指纹、资源上限指纹、网络模式和 Linux 进程树证明，Runtime 会逐项复核。

`build:linux-sandbox` 只能在 x64 Linux 运行：先执行 Rust 测试，再构建 release binary、复制进 Execution Node 原生资源目录并执行真实 probe；Linux 桌面出包和发布校验都会重复要求 helper 与平台 probe，失败便拒绝出包。仓库不提交当前 macOS 生成的伪二进制，也没有直接 `child_process.spawn()` 回退。

Linux/Windows helper 构建成功后还会原子生成 `traceforge-native-helper-release-v1` 清单，把平台、架构、后端、helper 协议、文件名和 SHA-256 绑定为一个安装单元。桌面发布包强制携带该清单；出包校验和每次应用启动使用同一份合同重新读取 helper 字节，缺清单、跨平台清单、未知字段、协议不匹配或摘要漂移都会关闭进程执行。开发态显式 helper 仍可不带发布清单，但必须通过相同原生 probe，不能由配置自报为可信。

Ubuntu 24.04 默认用 AppArmor 限制非特权 user namespace。仓库提供只附着到 `/usr/lib/traceforge/traceforge-linux-sandbox` 的 `flags=(unconfined) { userns, }` Profile；helper 二进制必须由 root 持有，不能通过全局关闭 `kernel.apparmor_restrict_unprivileged_userns` 绕过。systemd 服务必须使用专用非 root 账号与 `Delegate=yes`，启动器把自身移入 `supervisor` 子 cgroup 后在空的服务 cgroup 上启用 cpu/io/memory/pids controller，再把该服务 cgroup 交给 helper。

每个执行现在用同一个不可预测运行 ID 关联 `traceforge-execution-*` cgroup 与 `run-execution-*` scratch。Execution Node 首次 probe 前独占调用 `recover`：只枚举这两个受控前缀，杀净仍存活的所属进程、等待空树、删除 cgroup 与 scratch；任何计数、清理或截止失败都会让 Linux 进程能力保持关闭。正常运行仍由 RAII 清理，恢复命令只处理 helper/宿主强杀留下的资源。

真实 Ubuntu 24.04/x86_64、Linux 6.8、cgroup v2 的历史协议 1 已通过 16 类验收：完整 probe；批准读写、deny mask 与宿主环境不继承；写目录中的绝对软链接不能改写宿主 `/usr/bin`；读写重叠时嵌套 deny 仍保持遮蔽；非规范策略根拒绝；无外部网络路由；seccomp 拒绝新 namespace；后台孤儿随根进程结束清空；CPU、内存、进程数、写 I/O 四类超限均以对应原因终止；不支持的网络模式和伪 cgroup 根 fail closed；helper 被 SIGKILL 后目标因死亡信号清空；Execution Node 父进程被 SIGKILL 后通过 helper 的 `PDEATHSIG` 继续向目标树传播，并由新宿主精确删除一个 cgroup 和一个 scratch 树。协议 2 的验收入口已扩成 19 类，新增真实 PTY 输入/resize/terminate、Ctrl-C 和 close-input/EOF；当前 macOS 只完成源码交叉检查，必须在合格 Linux 主机重新通过 19 类门禁后才能把 PTY 写成实机证明。

## 本机 IPC 与逐操作可靠性

产品唯一执行链是“本机应用 → 本机 Execution Node → 本机原生沙箱”。应用与 Execution Node 虽在同一台机器，仍用用户私有命名管道隔开进程边界；Unix socket 创建后权限收紧为 `0600`，Windows 使用当前用户命名管道。RPC 不监听 TCP，不接受 TLS 或远程地址，也没有远程节点证书、节点世代证明或跨主机调度入口。

协议 1.8 要求每条 stdin、PTY resize、signal、terminate 和 adopt 请求携带稳定 `operationId`。本机 Execution Node 在触碰真实沙箱进程前，把完整操作身份和请求摘要写入有界 SQLite 账本，成功后再保存响应：

- 同一 ID、同一请求重放时直接返回已保存结果，不重复产生副作用；
- 换内容复用 ID 会拒绝；
- 只有 claim 而没有完成结果时按未知处理，绝不猜测没有执行；
- adopt 的成功响应连同新 token 一起保存，所以旧 token 已失效后仍能回放原接管结果；
- 账本数量、活跃数量、总预留空间、单条大小和物理磁盘压力都有门禁；超过保留期的已确认响应可以压缩归档并透明回放，未知 claim 永不压缩或删除；归档事务被强杀时重启只能看到完整原记录或完整归档。

这不是远程服务器功能。它防的是同机应用进程与执行进程之间的 IPC 超时、进程崩溃或响应丢失，避免同一段输入、信号或终止命令执行两次。

## 安装、启动、健康与关闭生命周期

桌面端只从当前安装包的 `resources/native/<platform>-x64` 选择 helper，同时把相邻 `release.json` 标记为必需，不搜索或下载远程节点。启动预检按顺序检查受支持平台/架构、helper 文件与执行权限、发布清单、Linux cgroup/scratch 绝对配置、启动残留恢复和真实原生 probe；每一类失败返回稳定 `reasonCode` 和修复方向，进程能力保持关闭，但资料查看等不依赖进程沙箱的本机能力仍可启动。

健康接口不公开 helper 绝对路径、cgroup 路径或配置秘密，只返回平台、后端、清单状态、启动清理数量、能力状态、逐操作账本的记录/活跃/归档/未知/字节容量摘要和稳定原因。每次读取健康状态都会重新计算 helper SHA-256；运行中替换、删除或无法读取 helper，或逐操作账本无法再接纳最坏大小的新控制记录，都会立即标成 `degraded`。后续每次真实启动前 Launcher 也会再次核对相同 measurement。健康检查不会重复调用 Linux `recover`，避免误杀正在运行的合法进程。

应用退出时先关闭本机 RPC 准入，再让 `LocalExecutionNode.shutdown()` 等待所有已开始但尚未登记完成的 launch 收敛，对每棵受管进程树发出强制终止，并在有界期限内等待原生退出/清理证明；没有证明全部终结就报错，不能把“请求已发送”写成“残留已清空”。关闭开始后拒绝任何新进程。桌面更新也不再因普通退出自动安装，必须由操作者明确触发版本切换。

## 已验证的故障窗口

本机 RPC 回归覆盖命名管道认证、帧大小、并发上限、请求截止、断开重连、进程接管和错误 token 拒绝。逐操作回归覆盖 SQLite 账本跨数据库重开、claim 残留拒绝重派、完成响应回放、输入与接管精确单次执行、操作 ID 冲突，以及 Runtime 重建后使用已保存 adopt 响应。独立真实 Node 宿主对五类控制分别在 claim 后和完成提交后执行十次 `SIGKILL`；归档又在事务提交前后执行两类 `SIGKILL`，新宿主均核对精确响应和 SQLite 完整性。

Linux 历史协议 1 的 16 类实机验收还覆盖 helper 和上层 Execution Node 被 SIGKILL 后的死亡传播、新宿主启动恢复、进程树清空以及 cgroup/scratch 零残留。协议 2 的 19 类入口尚待 Linux 实机重跑。这些测试可以在临时 Linux 验收机上运行，但验收机不是产品执行节点。

## 仍未完成的生产条件

- 扩展到第二种发行版/内核、aarch64、只读系统目录和真实桌面安装包；当前平台证明只覆盖 Ubuntu 24.04/x86_64/Linux 6.8，不应外推为所有 Linux。
- 补充更广的路径 fuzz、完整生产服务/数据库重启组合验收，以及不支持 clone3/mount_setattr 的旧内核拒绝证明。cgroup `io.stat` 是事后越界终止监视，对缓冲写/tmpfs 不应宣传为零超调磁盘配额。
- 发布包与运行时的 helper 清单/摘要校验已经接通；桌面自动更新、相邻旧版本保留、首次启动确认、安装器级失败回退和撤销记录按用户要求暂缓，不属于当前底座开发优先级。当前只保留禁止静默随退出安装的安全默认值，不能宣称桌面更新闭环已经完成。
- 在真实 Ubuntu x64 上重跑协议 2 的 19 类门禁，并继续扩充 adopt 等上层控制与真实 OS 沙箱进程组合的强杀窗口；完成 Windows 双模式实机验收。
- 第二种 Linux 发行版/内核与 aarch64 只用于兼容性验证，不引入远程产品能力。

通俗地说，安全工具始终关在用户电脑上的隔离执行室里。应用和执行室之间虽然只有一道本机门，也会给每次输入、调窗和发信号单独记账；门突然断开时不会盲目再执行一次。VPS 只负责替我们检验 Linux 版墙体是否牢固，产品运行不需要连接它。
