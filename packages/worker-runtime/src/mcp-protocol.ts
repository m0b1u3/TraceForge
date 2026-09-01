import { createHash } from "node:crypto";
import type { ExecutionToolSpec } from "./model.js";
import { executionToolContractFingerprint } from "./tool-provider-contract.js";
import { TOOL_PROVIDER_RPC_VERSION, type ToolProviderRpcRequest } from "./tool-provider-rpc.js";

/** Host-reviewed allowlist. Server descriptions, annotations and instructions cannot change this policy. */
export interface McpToolPolicy {
  remoteName: string;
  tool: ExecutionToolSpec;
  arguments?: Record<string, string>;
}
export interface McpProtocolOptions {
  serverName: string;
  serverVersion: string;
  tools: readonly McpToolPolicy[];
  /** One bounded reviewed catalog per source; context calls have no model-supplied parameters. */
  catalog?: "tools" | "resources" | "prompts";
}

/** A pinned MCP profile, carried exclusively over Execution Node stdio. */
export class McpProtocol {
  private buffered = Buffer.alloc(0);
  private readonly requests = new Map<string, ToolProviderRpcRequest>();
  private responses: Buffer[] = [];
  private readonly options: McpProtocolOptions;
  constructor(options: McpProtocolOptions, private readonly maximumBytes: number) {
    this.options = structuredClone(options);
    if (!options.serverName.trim() || !options.serverVersion.trim() || options.tools.length > 128
      || new Set(options.tools.map((t) => t.tool.name)).size !== options.tools.length
      || new Set(options.tools.map((t) => t.remoteName)).size !== options.tools.length) throw new Error("Invalid MCP policy");
    for (const { remoteName, tool } of options.tools) {
      if (!remoteName.trim() || tool.inputSchema.type !== "object") throw new Error("MCP requires pinned object input schemas");
    }
  }

  encode(request: ToolProviderRpcRequest): Buffer {
    let method: string; let params: unknown;
    if (request.method === "provider.handshake") {
      method = "initialize";
      params = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "traceforge", version: "1" } };
    } else if (request.method === "tools.list") { method = `${this.options.catalog ?? "tools"}/list`; params = {}; }
    else if (request.method === "tools.call") {
      const call = request.params as { tool: string; input: unknown };
      const policy = this.options.tools.find((p) => p.tool.name === call.tool);
      if (!policy) throw new Error("MCP tool is not allowlisted");
      // Do not give the child process Run authorization envelopes or internal control-plane identifiers.
      if (this.options.catalog === "resources") { method = "resources/read"; params = { uri: policy.remoteName }; }
      else if (this.options.catalog === "prompts") { method = "prompts/get"; params = { name: policy.remoteName, arguments: policy.arguments ?? {} }; }
      else { method = "tools/call"; params = { name: policy.remoteName, arguments: call.input }; }
    } else throw new Error("MCP method is not supported");
    const frame = this.frame({ jsonrpc: "2.0", id: request.id, method, params });
    this.requests.set(request.id, request);
    return frame;
  }

  initialized(): Buffer { return this.frame({ jsonrpc: "2.0", method: "notifications/initialized" }); }
  takeResponses(): Buffer[] { const frames = this.responses; this.responses = []; return frames; }

  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const result: unknown[] = [];
    let newline: number;
    while ((newline = this.buffered.indexOf(10)) >= 0) {
      if (newline > this.maximumBytes) throw new Error("MCP frame exceeds limit");
      const line = this.buffered.subarray(0, newline); this.buffered = this.buffered.subarray(newline + 1);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      for (const item of Array.isArray(value) ? value : [value]) {
        const response = this.response(item);
        if (response !== undefined) result.push(response);
      }
    }
    if (this.buffered.length > this.maximumBytes) throw new Error("MCP partial frame exceeds limit");
    return result;
  }

  private response(value: unknown): unknown {
    if (!record(value) || value.jsonrpc !== "2.0") throw new Error("Invalid MCP envelope");
    if (typeof value.method === "string") {
      if (value.method === "ping" && (typeof value.id === "string" || typeof value.id === "number")) {
        this.responses.push(this.frame({ jsonrpc: "2.0", id: value.id, result: {} }));
        return undefined;
      }
      // No sampling, elicitation, roots or implicit Host capabilities are negotiated.
      if ("id" in value) throw new Error("MCP server attempted an unnegotiated reverse request");
      if (["notifications/tools/list_changed", "notifications/resources/list_changed", "notifications/resources/updated", "notifications/prompts/list_changed"].includes(value.method)) throw new Error("MCP catalog changed; rediscovery required");
      return undefined; // progress/log notifications are not instructions or model context
    }
    if (typeof value.id !== "string" || ("result" in value) === ("error" in value)) throw new Error("Invalid MCP response");
    const request = this.requests.get(value.id);
    if (!request) return undefined;
    this.requests.delete(value.id);
    if ("error" in value) return { version: TOOL_PROVIDER_RPC_VERSION, id: value.id, ok: false,
      error: { code: "mcp_error", message: "MCP server rejected request", retryable: false } };
    const raw = value.result;
    let result: unknown;
    if (request.method === "provider.handshake") {
      if (!record(raw) || raw.protocolVersion !== "2025-03-26" || !record(raw.serverInfo)
        || raw.serverInfo.name !== this.options.serverName || raw.serverInfo.version !== this.options.serverVersion
        || !record(raw.capabilities) || !record(raw.capabilities[this.options.catalog ?? "tools"])) throw new Error("MCP initialization identity or protocol mismatch");
      result = { providerId: this.options.serverName, providerVersion: this.options.serverVersion, protocolVersion: TOOL_PROVIDER_RPC_VERSION };
    } else if (request.method === "tools.list") {
      const catalog = this.options.catalog ?? "tools";
      const items = record(raw) ? raw[catalog] : undefined;
      if (!record(raw) || !Array.isArray(items) || items.length > 128 || raw.nextCursor !== undefined) {
        throw new Error("MCP catalog is invalid, oversized or requires unsupported pagination");
      }
      const discovered = new Map<string, Record<string, unknown>>();
      for (const item of items) {
        const identity = record(item) ? item[catalog === "resources" ? "uri" : "name"] : undefined;
        if (!record(item) || typeof identity !== "string" || discovered.has(identity)) throw new Error("Invalid MCP catalog identity");
        discovered.set(identity, item);
      }
      result = this.options.tools.map(({ remoteName, tool, arguments: args }) => {
        const remote = discovered.get(remoteName);
        if (!remote || (catalog === "tools" && (!record(remote.inputSchema)
          || executionToolContractFingerprint({ ...tool, inputSchema: remote.inputSchema }) !== executionToolContractFingerprint(tool)))) {
          throw new Error("MCP tool schema differs from host-reviewed policy");
        }
        if (catalog === "prompts") {
          const declared = remote.arguments ?? [];
          if (!Array.isArray(declared) || declared.length > 16 || declared.some((a) => !record(a) || typeof a.name !== "string"
            || (a.required !== undefined && typeof a.required !== "boolean"))
            || new Set(declared.map((a) => a.name)).size !== declared.length
            || declared.some((a) => a.required && !Object.hasOwn(args ?? {}, a.name))
            || Object.keys(args ?? {}).some((key) => !declared.some((a) => a.name === key))) throw new Error("MCP prompt arguments changed");
        }
        return structuredClone(tool);
      });
    } else if (this.options.catalog === "resources" || this.options.catalog === "prompts") {
      const call = request.params as { tool: string };
      const policy = this.options.tools.find((p) => p.tool.name === call.tool)!;
      let content: string;
      if (this.options.catalog === "resources") {
        if (!record(raw) || !Array.isArray(raw.contents) || raw.contents.length !== 1) throw new Error("Expected one pinned text resource");
        const item = raw.contents[0];
        if (!record(item) || item.uri !== policy.remoteName || typeof item.text !== "string" || "blob" in item) throw new Error("Invalid MCP text resource");
        content = item.text;
      } else {
        if (!record(raw) || !Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > 32) throw new Error("Invalid MCP prompt messages");
        content = JSON.stringify(raw.messages.map((message) => {
          if (!record(message) || !["user", "assistant"].includes(String(message.role)) || !record(message.content)
            || message.content.type !== "text" || typeof message.content.text !== "string") throw new Error("Only text prompt data is supported");
          // Roles remain inert JSON data, never promoted into the model's message envelope.
          return { role: message.role, content: { type: "text", text: message.content.text } };
        }));
      }
      if (Buffer.byteLength(content) > 64 * 1024) throw new Error("MCP context exceeds text budget");
      result = { status: "succeeded", summary: "Pinned external context candidate; host digest validation required", raw: content,
        refs: [], retryable: false, metadata: { trust: "untrusted_context", provider: this.options.serverName } };
    } else {
      if (!record(raw) || !Array.isArray(raw.content) || (raw.isError !== undefined && typeof raw.isError !== "boolean")) throw new Error("Invalid MCP tool result");
      // Preserve the bounded original blocks for audit. No server-generated URI becomes an evidence reference.
      const text = JSON.stringify(raw);
      const digest = createHash("sha256").update(text).digest("hex");
      result = { status: raw.isError ? "failed" : "succeeded", summary: "Untrusted MCP tool observation; not verified evidence",
        raw: text, refs: [], retryable: false,
        metadata: { trust: "untrusted_observation", provider: this.options.serverName, version: this.options.serverVersion, digest: `sha256:${digest}` } };
    }
    return { version: TOOL_PROVIDER_RPC_VERSION, id: value.id, ok: true, result };
  }

  private frame(value: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > this.maximumBytes) throw new Error("MCP request exceeds frame limit");
    return Buffer.concat([payload, Buffer.from("\n")]);
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
