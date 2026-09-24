import { createHash } from "node:crypto";
import { parallelToolName, type ExecutionToolSpec, type WorkerDecision, type WorkerModelRequest } from "@traceforge/worker-runtime";

export interface NativeWorkerTurn {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  done: boolean;
}

export interface NativeWorkerTools {
  definitions: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  parse(turn: NativeWorkerTurn): WorkerDecision;
}

const control = {
  complete: "tf_complete",
  block: "tf_block",
  inquire: "tf_inquire",
  requestPermissions: "tf_request_permissions",
} as const;

function alias(tool: ExecutionToolSpec): string {
  const slug = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 38);
  const digest = createHash("sha256").update(tool.name).digest("hex").slice(0, 12);
  return `tf_${slug}_${digest}`;
}

function invocationId(turnId: string, callId: string): string {
  return `native_${createHash("sha256").update(turnId).update("\0").update(callId).digest("hex").slice(0, 32)}`;
}

function functionInputSchema(tool: ExecutionToolSpec): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
    || (schema.type !== undefined && schema.type !== "object")) {
    throw new Error(`Native function ${tool.name} requires an object input Schema`);
  }
  // Worker decisions only admit object arguments. Some valid local Schemas
  // express that through oneOf; providers also require an explicit root type.
  return { ...schema, type: "object" };
}

/** Provider function names are aliases; the current Host catalog remains the sole authority. */
export function nativeWorkerTools(request: WorkerModelRequest): NativeWorkerTools {
  const catalog = new Map<string, ExecutionToolSpec>();
  const definitions: NativeWorkerTools["definitions"] = [];
  if (request.executionMode !== "conclude") {
    for (const tool of request.tools) {
      // This is an internal durable batch carrier. The model produces separate
      // read calls; the Host groups them only when there are at least two.
      if (tool.name === parallelToolName) continue;
      const name = alias(tool);
      if (catalog.has(name)) throw new Error("Native tool alias collision");
      catalog.set(name, tool);
      definitions.push({ name, description: `${tool.name}: ${tool.description}`, input_schema: functionInputSchema(tool) });
    }
    const kind = request.outputContract?.allowedKinds ?? [];
    definitions.push({ name: control.complete, description: "Complete this Work with supported output references.",
      input_schema: { type: "object", additionalProperties: false, required: ["summary", "outputs"], properties: {
        summary: { type: "string" }, outputs: { type: "array", ...(kind.length ? {} : { maxItems: 0 }),
          items: { type: "object", additionalProperties: false, required: ["id", "kind", "summary", "refs"], properties: {
            id: { type: "string" }, kind: { type: "string", ...(kind.length ? { enum: kind } : {}) },
            summary: { type: "string" }, refs: { type: "array", items: { type: "string" } },
          } } },
      } } });
    definitions.push({ name: control.inquire, description: "Ask the Planner a concrete question about this Work.",
      input_schema: { type: "object", additionalProperties: false, required: ["reason", "refs"], properties: {
        reason: { type: "string" }, refs: { type: "array", items: { type: "string" } },
      } } });
    definitions.push({ name: control.requestPermissions, description: "Pause for explicit user review of a proposed authorization scope; grants nothing.",
      input_schema: { type: "object", additionalProperties: false, required: ["reason", "scope"], properties: {
        reason: { type: "string" }, scope: { type: "object" },
      } } });
  }
  definitions.push({ name: control.block, description: "Stop this Work and report the concrete reason and remaining limitation.",
    input_schema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } } });

  return { definitions, parse(turn) {
    if (turn.toolCalls.length > 1) {
      const calls = turn.toolCalls;
      const batch = request.tools.find(tool => tool.name === parallelToolName);
      if (!batch || new Set(calls.map(call => call.id)).size !== calls.length
        || calls.some(call => !call.id || call.id.length > 200 || !catalog.has(call.name)
          || catalog.get(call.name)!.name === parallelToolName || catalog.get(call.name)!.risk !== "read_only"
          || !call.input || typeof call.input !== "object" || Array.isArray(call.input))) {
        throw new Error("Worker model returned incompatible simultaneous function calls");
      }
      return { type: "invoke_tool", invocation: {
        id: invocationId(request.turnId, calls.map(call => call.id).join("\0")), tool: parallelToolName,
        rationale: turn.text.trim().slice(0, 1000) || "Run independent read-only calls",
        input: { calls: calls.map(call => ({ id: call.id, tool: catalog.get(call.name)!.name,
          input: call.input, rationale: `Read with ${catalog.get(call.name)!.name}` })) },
      } };
    }
    if (turn.toolCalls.length !== 1) throw new Error("Worker model must call exactly one available function");
    const call = turn.toolCalls[0]!;
    if (!call.id || call.id.length > 200) throw new Error("Worker model returned an invalid function call ID");
    const input = call.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Worker model function input must be an object");
    if (call.name === control.block) return { type: "block", reason: (input as { reason: string }).reason };
    if (request.executionMode === "conclude") throw new Error("Conclusion mode allows only block");
    if (call.name === control.complete) return { type: "complete",
      summary: (input as { summary: string }).summary, outputs: (input as { outputs: [] }).outputs };
    if (call.name === control.inquire) return { type: "inquire",
      reason: (input as { reason: string }).reason, refs: (input as { refs: string[] }).refs };
    if (call.name === control.requestPermissions) return { type: "request_permissions",
      reason: (input as { reason: string }).reason, scope: (input as { scope: Record<string, unknown> }).scope };
    const tool = catalog.get(call.name);
    if (!tool) throw new Error("Worker model called a function outside its current catalog");
    return { type: "invoke_tool", invocation: {
      id: invocationId(request.turnId, call.id), tool: tool.name, input,
      rationale: turn.text.trim().slice(0, 1000) || `Call ${tool.name} for this Work`,
    } };
  } };
}
