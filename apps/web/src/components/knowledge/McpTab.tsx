import { useStore } from "../../store.js";
export function McpTab() {
  const mcpTools = useStore((s) => s.mcpTools);
  if (mcpTools.length === 0) return <div className="tf-empty">暂无 MCP 工具（配置 config/mcp.json 后出现）。</div>;
  return <>{mcpTools.map((t) => (
    <div className="tf-row" key={`${t.serverName}/${t.toolName}`}>
      <span className="tf-tag">{t.serverName}</span>{t.toolName}
      <span style={{ color: "var(--tf-faint)" }}> — {t.description}</span>
    </div>
  ))}</>;
}
