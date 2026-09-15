import { ModelContextOverflowError } from "@traceforge/shared/model-context";

/** Narrow protocol error classification. No raw upstream text escapes. */
export function normalizeContextOverflow(error: unknown): unknown {
  if (error instanceof ModelContextOverflowError) return error;
  if (!error || typeof error !== "object") return error;
  const value = error as { status?: unknown; code?: unknown; error?: { code?: unknown; type?: unknown; message?: unknown } };
  if (![400, 413, 422].includes(value.status as number)) return error;
  const code = value.error?.code ?? value.code;
  if (["context_length_exceeded", "max_context_length_exceeded", "prompt_too_long"].includes(code as string)
    || (value.status === 400 && value.error?.type === "invalid_request_error" && typeof value.error.message === "string"
      && /^prompt is too long:/i.test(value.error.message))) return new ModelContextOverflowError("remote_rejection");
  return error;
}

export async function responseContextOverflow(response: Response): Promise<ModelContextOverflowError | undefined> {
  if (![400, 413, 422].includes(response.status)) { await response.body?.cancel(); return; }
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    let text = "", bytes = 0; const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 16384) return;
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const value = normalizeContextOverflow({ status: response.status, error: JSON.parse(text)?.error });
    return value instanceof ModelContextOverflowError ? value : undefined;
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); }
}
