import type { ExtractJsonArgs, LlmProvider, RunToolsArgs, RunTurn, StreamToolsHandlers, TurnMessage, UsageSnapshot } from "./provider.js";
import type { ModelAdapterOptions } from "./adapter-options.js";

class ResponsesError extends Error {}

const MAX_BYTES = 16 * 1024 * 1024;
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResponsesError("Invalid Responses payload");
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new ResponsesError("Invalid Responses text");
  return value;
}

/** Stateless wire adapter. No tools are executed and no upstream conversation
 * IDs, provider accounts, host storage or Scenario policy are owned here.
 */
export class ResponsesProvider implements LlmProvider {
  constructor(private options: ModelAdapterOptions) {
    if (options.requestOptions?.thinking !== undefined) throw new ResponsesError("Responses does not support the thinking option; select reasoningEffort instead");
    if (options.embeddingModel) throw new ResponsesError("Responses connection does not provide embeddings; use a separate compatible route");
  }

  private body(system: string, input: unknown[]) {
    const opts = this.options;
    return { model: opts.model, instructions: system, input, store: false,
      ...(opts.maxOutputTokens === undefined ? {} : { max_output_tokens: opts.maxOutputTokens }),
      ...(opts.requestOptions?.temperature === undefined ? {} : { temperature: opts.requestOptions.temperature }),
      ...(opts.requestOptions?.reasoningEffort === undefined ? {} : { reasoning: { effort: opts.requestOptions.reasoningEffort } }) };
  }
  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    const format = this.options.jsonMode === "json_object" ? { type: "json_object" }
      : { type: "json_schema", name: "extraction", schema: args.schema, strict: false };
    const result = await this.request({ ...this.body(`${args.system}\nReturn JSON matching: ${JSON.stringify(args.schema)}`,
      [{ role: "user", content: args.user }]), text: { format } }, { signal: args.signal, onUsage: args.onUsage });
    if (result.toolCalls.length || !result.text) throw new ResponsesError("Responses did not return JSON text");
    try { return JSON.parse(result.text); } catch { throw new ResponsesError("Responses returned invalid JSON"); }
  }
  runTools(args: RunToolsArgs): Promise<RunTurn> { return this.turn(args, { onUsage: args.onUsage }); }
  streamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> { return this.turn(args, handlers, true); }
  private turn(args: RunToolsArgs, handlers: StreamToolsHandlers, stream = false) {
    return this.request({ ...this.body(args.system, responsesInput(args.messages)),
      tools: args.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description,
        parameters: tool.input_schema, strict: false })), stream }, handlers, stream);
  }
  private async request(body: Json, handlers: StreamToolsHandlers, streaming = false): Promise<RunTurn> {
    const controller = new AbortController();
    const signal = handlers.signal ? AbortSignal.any([handlers.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new ResponsesError("Model request timed out")), 120000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl!.replace(/\/+$/, "")}/responses`, {
        method: "POST", headers: { "content-type": "application/json", accept: streaming ? "text/event-stream" : "application/json",
          authorization: `Bearer ${this.options.apiKey}` }, body: JSON.stringify(body), signal, redirect: "manual" });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new ResponsesError(`Model request failed (HTTP ${response.status})`), { status: response.status });
      }
      if (streaming && !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new ResponsesError("Expected Responses event stream");
      reader = response.body?.getReader();
      if (!reader) throw new ResponsesError("Empty Responses body");
      let bytes = 0; let buffer = ""; const decoder = new TextDecoder();
      let final: RunTurn | undefined; let delivered = "";
      const event = (frame: string) => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data === "[DONE]") return;
        if (final) throw new ResponsesError("Unexpected event after completed response");
        let value: Json;
        try { value = object(JSON.parse(data)); } catch { throw new ResponsesError("Invalid Responses event"); }
        if (value.type === "response.output_text.delta") {
          const delta = string(value.delta); delivered += delta; handlers.onTextDelta?.(delta);
        } else if (value.type === "response.completed") {
          final = parseResponse(value.response, handlers.onUsage);
          if (delivered && delivered !== final.text) throw new ResponsesError("Responses stream text did not match its completion");
          if (!delivered && final.text) handlers.onTextDelta?.(final.text);
        } else if (["error", "response.failed", "response.incomplete"].includes(String(value.type))) {
          throw new ResponsesError("Responses stream failed or was incomplete");
        }
      };
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) throw new ResponsesError("Responses body exceeds limit");
        buffer += decoder.decode(next.value, { stream: true });
        if (streaming) {
          let separator: RegExpExecArray | null;
          while ((separator = /\r?\n\r?\n/.exec(buffer))) {
            event(buffer.slice(0, separator.index)); buffer = buffer.slice(separator.index + separator[0].length);
          }
        }
      }
      buffer += decoder.decode(); signal.throwIfAborted();
      if (streaming) {
        if (buffer.trim()) event(buffer);
        if (!final) throw new ResponsesError("Responses stream ended without completion");
        return final;
      }
      let payload: unknown;
      try { payload = JSON.parse(buffer); } catch { throw new ResponsesError("Invalid Responses JSON"); }
      return parseResponse(payload, handlers.onUsage);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      // Transport exceptions can contain URLs or upstream bodies. Do not expose them.
      if (error instanceof ResponsesError) throw error;
      throw new ResponsesError("Responses transport failed");
    } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
  }
}

export function responsesInput(messages: TurnMessage[]): unknown[] {
  const input: unknown[] = []; const outstanding = new Set<string>(); const used = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId || !outstanding.delete(message.toolCallId)) throw new ResponsesError("Tool result has no matching Responses call");
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    } else {
      if (outstanding.size) throw new ResponsesError("Responses tool results are missing");
      if (message.content) input.push({ role: message.role, content: message.content });
      for (const tool of message.toolCalls ?? []) {
        if (message.role !== "assistant" || !tool.id || used.has(tool.id)) throw new ResponsesError("Invalid Responses tool call history");
        used.add(tool.id); outstanding.add(tool.id);
        input.push({ type: "function_call", call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.input) });
      }
    }
  }
  if (outstanding.size) throw new ResponsesError("Responses tool results are missing");
  return input;
}

function parseResponse(payload: unknown, onUsage?: (usage: UsageSnapshot) => void): RunTurn {
  const response = object(payload);
  if (response.status !== "completed" || response.error || !Array.isArray(response.output)) throw new ResponsesError("Responses result was not complete");
  const turn: RunTurn = { text: "", toolCalls: [], done: true }; const ids = new Set<string>();
  for (const value of response.output) {
    const item = object(value);
    if (item.type === "message") {
      if (item.status !== "completed" || item.role !== "assistant" || !Array.isArray(item.content)) throw new ResponsesError("Invalid Responses message");
      for (const value of item.content) {
        const content = object(value);
        if (content.type === "refusal") throw new ResponsesError("Responses request was refused");
        if (content.type !== "output_text") throw new ResponsesError("Responses output type is unsupported");
        turn.text += string(content.text);
      }
    } else if (item.type === "function_call") {
      if (item.status !== undefined && item.status !== "completed") throw new ResponsesError("Responses tool call was incomplete");
      const id = string(item.call_id); const name = string(item.name);
      if (!id || !name || ids.has(id)) throw new ResponsesError("Invalid Responses tool identity");
      ids.add(id); let input: unknown;
      try { input = JSON.parse(string(item.arguments)); } catch { throw new ResponsesError("Invalid Responses tool arguments"); }
      turn.toolCalls.push({ id, name, input });
    } else if (item.type === "reasoning") {
      // Opaque reasoning continuation is not representable in the current
      // provider-neutral history. Fail rather than silently discard it.
      if (item.encrypted_content) throw new ResponsesError("Responses encrypted reasoning continuation is not supported");
    } else throw new ResponsesError("Responses output type is unsupported");
  }
  turn.done = turn.toolCalls.length === 0;
  if (response.usage) {
    const usage = object(response.usage);
    const values = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
    if (values.some(value => !Number.isSafeInteger(value) || (value as number) < 0)) throw new ResponsesError("Invalid Responses usage");
    onUsage?.({ promptTokens: values[0] as number, completionTokens: values[1] as number, totalTokens: values[2] as number });
  }
  return turn;
}
