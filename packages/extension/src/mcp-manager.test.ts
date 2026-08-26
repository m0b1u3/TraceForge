import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager } from "./mcp-manager.js";
import { mcpToolToDescriptor } from "./mcp-tools.js";

describe("McpManager real stdio integration", () => {
  let manager: McpManager;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tf-mcp-"));
    await mkdir(join(workspace, "case_1"));
    manager = new McpManager();
    await manager.connectAll([{
      name: "poc",
      command: process.execPath,
      args: [resolve("packages/mcp-poc-server/dist/main.js")],
      env: {
        TRACEFORGE_WORKSPACE: workspace,
        TRACEFORGE_WINDOWS_SANDBOX_HELPER: join(workspace, "missing-sandbox-helper.exe"),
      },
    }]);
  });

  afterEach(async () => {
    await manager.closeAll();
    await rm(workspace, { recursive: true, force: true });
  });

  it("discovers tools and calls the real MCP child process", async () => {
    const handles = manager.listTools();
    expect(handles.map((handle) => handle.toolName).sort()).toEqual(["list_dir", "read_file", "write_file"]);
    expect(handles.every((handle) => handle.serverName === "poc")).toBe(true);

    const result = await manager.callTool("poc", "list_dir", { caseId: "case_1", path: "" });
    expect(result).toEqual({ ok: true, content: "(empty)" });
  });

  it("returns ok:false for an unknown server", async () => {
    const result = await manager.callTool("missing", "list_dir", { caseId: "case_1" });
    expect(result.ok).toBe(false);
  });

  it("wraps and executes a discovered MCP tool without changing its public name", async () => {
    const handle = manager.listTools().find((candidate) => candidate.toolName === "list_dir");
    expect(handle).toBeDefined();

    const descriptor = mcpToolToDescriptor(handle!, manager);
    expect(descriptor.name).toBe("list_dir");
    expect(descriptor.source).toBe("mcp:poc");
    expect(descriptor.security).toMatchObject({
      capabilities: ["data.read"],
      impactScope: "case",
      mutates: false,
      destructive: false,
      openWorld: false,
    });
    await expect(descriptor.execute({ caseId: "case_1", path: "" })).resolves.toEqual({
      ok: true,
      content: "(empty)",
    });
  });
});
