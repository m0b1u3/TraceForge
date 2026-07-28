import { useStore } from "../../store.js";
import { FeedbackState } from "../ui/feedback-state.js";
import { Plugs } from "@phosphor-icons/react";

export function McpTab() {
  const mcpTools = useStore((s) => s.mcpTools);
  if (mcpTools.length === 0) return <FeedbackState title="No MCP tools available" description="Configure MCP servers in config/mcp.json to include their tools in the Agent toolset." />;

  const groups = mcpTools.reduce((result, tool) => {
    const tools = result.get(tool.serverName);
    if (tools) tools.push(tool);
    else result.set(tool.serverName, [tool]);
    return result;
  }, new Map<string, typeof mcpTools>());
  return <div className="mcp-server-list">{Array.from(groups, ([serverName, tools]) => (
    <section className="mcp-server-group" key={serverName} aria-label={`${serverName} MCP server`}>
      <header>
        <span><Plugs size={14} aria-hidden="true" /><strong>{serverName}</strong></span>
        <small>{tools.length} {tools.length === 1 ? "tool" : "tools"}</small>
      </header>
      <div>
        {tools.map((tool) => (
          <article className="tf-row mcp-tool-row" key={`${tool.serverName}/${tool.toolName}`}>
            <div className="mcp-tool-head"><strong>{tool.toolName}</strong></div>
            <p>{tool.description}</p>
          </article>
        ))}
      </div>
    </section>
  ))}</div>;
}
