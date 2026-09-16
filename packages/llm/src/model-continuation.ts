import { createHash } from "node:crypto";
import type { ModelAdapterOptions } from "./adapter-options.js";
import type { ModelContinuation } from "./provider.js";

function connection(options: ModelAdapterOptions, protocol: string): string {
  return createHash("sha256").update(JSON.stringify([protocol, options.model, options.baseUrl?.replace(/\/+$/, "") ?? "", options.continuationScope ?? options.apiKey])).digest("hex");
}
export function continuation(options: ModelAdapterOptions, state: ModelContinuation["state"]): ModelContinuation {
  // Keep opaque provider state bounded; it is not a second transcript store.
  if (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024) throw new Error("Model continuation exceeds limit");
  return { connection: connection(options, state.protocol), state };
}
export function continuationState<P extends ModelContinuation["state"]["protocol"]>(value: ModelContinuation | undefined,
  options: ModelAdapterOptions, protocol: P): Extract<ModelContinuation["state"], {protocol:P}> | undefined {
  if (!value || value.connection !== connection(options, protocol) || value.state.protocol !== protocol) return undefined;
  return value.state as Extract<ModelContinuation["state"], {protocol:P}>;
}
