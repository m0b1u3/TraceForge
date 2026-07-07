# Frontend LLM Configuration UI

## Goal

让 TraceForge 的 LLM 配置可以通过前端界面直接查看和修改，并保存后即时生效，替代当前必须手动编辑 `config/llm.json` 和 `.env` 的低效方式。

## Architecture

新增一个后端配置模块 `LlmConfigService`，负责读写 `config/llm.json` 和 `.env`，并在保存后重建 `LlmProvider` 实例。前端通过新 API 与后端交互。

## Data Model

`config/llm.json` 保持现有结构：

```json
{
  "provider": "openai",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "jsonMode": "json_object"
}
```

- `apiKeyEnv` 保留现有名称，不强制改为固定名称
- 真实 API key 存储在 `.env` 中，由 `apiKeyEnv` 指向
- 前端不直接暴露完整 key，只显示 mask 后的占位

## API Design

### GET /api/config/llm

返回当前配置（脱敏）：

```json
{
  "provider": "openai",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "apiKeyMasked": "sk-••••••••",
  "jsonMode": "json_object"
}
```

- `apiKeyMasked` 在 key 未设置时为空字符串
- 绝不返回完整 key

### POST /api/config/llm

Body：

```json
{
  "provider": "openai",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-...",
  "jsonMode": "json_object"
}
```

- `apiKey` 为空字符串表示不修改 key
- 后端先读取当前 `llm.json` 得到 `apiKeyEnv`，缺失时按 provider 生成默认值
- 更新 `llm.json`
- 更新 `.env` 中对应 key 行，保留其他变量
- 重建 provider
- 成功后返回最新配置（mask 后的 key）

## Backend Changes

### LlmConfigService

位置：`apps/server/src/llm-config-service.ts`

职责：
- `load()`：读取 `config/llm.json` 和 `.env`，创建 provider
- `reload(dto)`：写文件、更新 `process.env`、重建 provider
- `getProvider()`：返回当前 provider
- `maskKey(key)`：生成 mask 字符串

### main.ts

- 创建 `LlmConfigService` 实例
- 将 `service.getProvider` 传入 `registerRoutes`，替代原来的固定 provider

### routes.ts

- 新增 `GET /api/config/llm`
- 新增 `POST /api/config/llm`
- agent 运行时从 `getProvider()` 获取当前 provider

## Frontend Changes

### TopBar.tsx

右侧添加「Settings」文字按钮，点击打开 Settings Modal。不使用 emoji 和齿轮图标。

### SettingsModal.tsx

新组件，遵循现有 `GraphModal.tsx` 的 modal 模式：
- 标题：Settings
- 两个 tab：Basic / Advanced
- Basic tab：
  - Provider：下拉选择 `anthropic` / `openai`
  - Model：文本输入
  - API Key：密码输入，placeholder 显示 mask
  - 当前 `apiKeyEnv` 只读展示
- Advanced tab：
  - Base URL：文本输入（可选）
  - JSON Mode：下拉选择 `json_schema` / `json_object` / 空
  - 环境变量名：文本输入（可编辑；为空时后端按 provider 默认生成）

### api.ts

新增：
- `getLlmConfig()`
- `updateLlmConfig(config)`

### store.ts

新增：
- `llmConfig` 状态
- `setLlmConfig`
- `loadLlmConfig` 异步 action

### app.css

复用现有 `tf-input`、`tf-btn`、`tf-modal-bg`、`tf-modal`、`tf-tabs` 等类，不新增大量样式。

## Behavior

- 打开 modal 时自动加载当前配置
- API Key 输入框 placeholder 在未输入时显示 mask 或 "Configured"
- 保存按钮提交期间禁用
- 保存成功后显示 toast："Settings saved"
- 保存失败显示错误 toast，modal 不关闭
- 保存后立即热重载 provider，下一次 agent 运行使用新配置

## Error Handling

- 读取 `llm.json` 失败：返回 200 但字段为空，provider 保持当前状态
- 写入文件失败：返回 500，不替换 provider
- provider 重建失败：返回 500，文件写入需回滚或先验证再写入
- API Key 为空且当前未配置：返回 400

## Testing

- 后端单元测试：`LlmConfigService` 在临时目录中读写和重载
- 后端路由测试：保存配置后调用真实 LLM 验证生效
- 前端组件测试：表单提交、tab 切换、错误展示
- 构建验证：`pnpm build`
- 全量测试：`pnpm test`

## Security Notes

- GET 接口只返回 mask 后的 key
- 写 `.env` 时只修改目标 key 行
- 当前无认证，符合本地应用定位

## Migration

首次保存后：
- 若已有 `config/llm.json`，保留 `apiKeyEnv` 不变
- 若 `.env` 中对应 key 已存在，覆盖其值
- 若都不存在，按 provider 生成默认 `apiKeyEnv`（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）并追加到 `.env`
