import { useStore } from "../../store.js";
import { FeedbackState } from "../ui/feedback-state.js";
export function McpTab() {
  const mcpTools = useStore((s) => s.mcpTools);
  if (mcpTools.length === 0) return <FeedbackState title="No MCP tools available" description="Configure MCP servers in config/mcp.json to include their tools in the Agent toolset." />;
  return <>{mcpTools.map((t) => (
    <article className="tf-row mcp-tool-row" key={`${t.serverName}/${t.toolName}`}>
      <div className="mcp-tool-head"><span className="tf-tag">{t.serverName}</span><strong>{t.toolName}</strong></div>
      <p>{t.description}</p>
    </article>
  ))}</>;
}
