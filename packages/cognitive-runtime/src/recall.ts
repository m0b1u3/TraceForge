import { createHash } from "node:crypto";

export interface RecallSource { text: string; refs: string[] }
export interface RecallPort<Reader> {
  /** Host must revalidate current ownership, authorization and source lifecycle.
   * Caller-supplied text or a model-provided digest is never authority. */
  readCurrent(id: string, reader: Reader): Promise<RecallSource>;
}

/** Bounded original-text paging, independent of SQLite, tools and Scenarios. */
export class ContextRecallRuntime<Reader> {
  constructor(private readonly port: RecallPort<Reader>) {}
  async read(input: { id: string; offset?: number; digest?: string }, reader: Reader, signal?: AbortSignal) {
    const offset = input.offset ?? 0;
    if (typeof input.id !== "string" || !input.id.length || input.id.length > 512 || !Number.isSafeInteger(offset) || offset < 0
      || (input.digest !== undefined && !/^[a-f0-9]{64}$/.test(input.digest)) || (offset > 0 && !input.digest)) throw new Error("Invalid recall request");
    signal?.throwIfAborted();
    const original = structuredClone(await this.port.readCurrent(input.id, reader));
    if (typeof original.text !== "string" || Buffer.byteLength(original.text) > 1048576 || !Array.isArray(original.refs)
      || original.refs.length > 256 || original.refs.some(ref => typeof ref !== "string" || ref.length > 4096)) throw new Error("Recall source exceeds limit");
    const digest = createHash("sha256").update(original.text).digest("hex");
    if ((input.digest && input.digest !== digest) || offset > original.text.length) throw new Error("Recall source changed or offset invalid");
    let end = Math.min(offset + 1200, original.text.length);
    if (end < original.text.length && /[\uD800-\uDBFF]/.test(original.text[end - 1])) end--;
    // Close revocation races across asynchronous storage access. Immutable text
    // and references must still match; no cached grant from the first read.
    signal?.throwIfAborted();
    const current = await this.port.readCurrent(input.id, reader);
    signal?.throwIfAborted();
    if (current.text !== original.text || JSON.stringify(current.refs) !== JSON.stringify(original.refs)) throw new Error("Recall source changed");
    return { id: input.id, digest, offset, nextOffset: end < original.text.length ? end : null,
      text: original.text.slice(offset, end), refs: original.refs, trust: "untrusted_context" as const };
  }
}
