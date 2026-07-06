import { useStore } from "../../store.js";
export function McpTab() {
  const mcpTools = useStore((s) => s.mcpTools);
  if (mcpTools.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No MCP tools available.</div><div className="tf-guide-hint">Configure MCP servers (e.g. PoC execution, filesystem) in config/mcp.json; tools will appear here and be included in the Agent toolset.</div></div>;
  return <>{mcpTools.map((t) => (
    <div className="tf-row" key={`${t.serverName}/${t.toolName}`}>
      <span className="tf-tag">{t.serverName}</span>{t.toolName}
      <span className="tf-text-faint"> — {t.description}</span>
    </div>
  ))}</>;
}
