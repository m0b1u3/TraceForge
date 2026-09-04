# Browser Runtime 发行来源策略

状态：底座信任机制已实现；正式发行来源尚未批准。

## 结论

TraceForge 不把开发机浏览器、系统自动更新 Chrome、Chrome for Testing、Chromium snapshot 或第三方打包 Chromium
直接当作生产 Browser Runtime。当前生产候选路线是：

1. 从 Chromium 官方 Git 仓库固定完整 commit；
2. 固定 `depot_tools`、依赖解析结果、编译参数和隔离构建环境；
3. 自行生成不带 Chrome 品牌的 Chromium 平台归档；
4. 对归档生成 SBOM、许可证/NOTICE 清单、漏洞评估和真实平台测试，并形成 Build Attestation；
5. 将 Build Attestation 摘要及最终归档的 URL、字节数、SHA-256、布局和评审摘要写入 Source Lock；
6. 由离线 Ed25519 评审密钥签署有限有效期的完整 Source Lock，再进入现有安全解压和 v3 release tree。

这是一项候选架构决定，不等于 Chromium 已获产品发行批准。只有实际构建材料、第三方依赖许可证清单、平台签名、
安全维护时限和原生断网测试全部齐备后，具体版本才能成为生产 Source Lock。

## 为什么不直接选现成下载

- [Chrome for Testing 官方说明](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)明确把它定位为自动化测试用途，
  并要求只处理可信内容；安全智能体会主动打开潜在恶意页面，因此不能把它的“版本固定”误当作生产安全适用性。
- [Chromium 官方下载说明](https://www.chromium.org/getting-involved/download-chromium/)指出公开 Chromium builds 是 best-effort，
  可能来自不能对应用户 Stable 发布的任意 revision；这不满足产品的安全更新和稳定版本责任。
- 正常 Chrome Stable 虽然具有成熟更新通道，但自动更新会破坏审核后固定身份，而且 Chrome 品牌二进制的再分发条件不能由
  Chromium 开源许可证替代判断。
- 第三方 Chromium 包会新增另一条构建者、签名密钥、更新节奏和补丁来源信任链；在没有单独审核前不进入默认候选。

## 已落地的强制门禁

- Build Attestation 严格固定 Chromium 官方仓库的完整 40 位 commit、源码依赖清单、`depot_tools` commit、依赖解析结果、
  GN 参数、构建配方、目标归档和完整浏览器树；只接受两个以上 builder、环境摘要和 provenance 摘要均不同且产出同一树摘要的独立复现；
- Attestation 同时固定 SPDX 2.3 或 CycloneDX 1.6 SBOM、NOTICE、安全评估、许可证评审和平台签名身份摘要；macOS 必须声明
  Apple Developer ID，Windows 必须声明 Authenticode，Linux 不接受用这两种签名冒充平台证明；
- Source Lock 严格固定来源、版本、完整 Chromium commit、平台/架构、归档大小/摘要、唯一根目录、启动路径、评审引用和
  Build Attestation 摘要；因此修改工具链、SBOM、评估或复现记录都会改变 Lock，原 Source Review 签名立即失效；
- Source Review 用 Ed25519 对精确 Lock 摘要签名，绑定受信 key、允许的 source ID、签发/过期时间；未知 key、越权、过期、
  未来签发、已撤销或签名错误全部拒绝；
- 评审 Authority 必须由发布宿主从 release tree 外部作为可信根提供，不能让归档自带公钥给自己背书；
- 归档通过同一文件句柄前后验真和有界安全解压后，生成包含 Lock、Review、Build Attestation、Controller 与完整 Browser tree
  摘要的发布材料；装配时实测树摘要必须与两次构建共同证明的树摘要一致；
- Controller 每次启动重新核对 Authority、Review、Lock、Build Attestation、release manifest 和安装树，评审到期或 key 被撤销后
  即使磁盘文件没变也不再启动。

## 正式批准仍需的材料

- 精确 Chromium commit 和该 commit 对应的安全修复基线；
- 实际固定依赖/工具链/编译参数及两次独立构建材料；合同和门禁已实现，但尚未执行大体积 Chromium 正式构建；
- 每个平台最终 ZIP 的稳定托管 URL、大小、SHA-256 和平台代码签名；
- Chromium 主许可证、所有随包第三方组件的 NOTICE/再分发义务及法务确认；
- SBOM、已知漏洞评估、补丁响应时限和紧急撤销/换代流程；
- macOS、Linux、Windows 的真实 Controller 全链，以及 Linux/Windows 原生 `network=deny` 证明。

通俗地说：底座现在不只会“验货”和检查“谁批准”，还会要求工厂交代是哪份官方源码、哪套工具和参数造出来的，并让两台独立
构建环境交出完全相同的整棵浏览器文件树。现在缺的是用真实构建机生产这些材料和各平台成品，不是继续发明证明字段；在此之前
Browser Provider 继续关闭。
