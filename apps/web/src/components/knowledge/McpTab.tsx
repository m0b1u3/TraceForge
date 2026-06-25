import { useStore } from "../../store.js";
export function McpTab() {
  const mcpTools = useStore((s) => s.mcpTools);
  if (mcpTools.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无 MCP 工具</div><div className="tf-guide-hint">在 config/mcp.json 配置 MCP server（如 PoC 执行、文件系统）后，工具会出现在这里并纳入 Agent 工具集。</div></div>;
  return <>{mcpTools.map((t) => (
    <div className="tf-row" key={`${t.serverName}/${t.toolName}`}>
      <span className="tf-tag">{t.serverName}</span>{t.toolName}
      <span style={{ color: "var(--tf-faint)" }}> — {t.description}</span>
    </div>
  ))}</>;
}
