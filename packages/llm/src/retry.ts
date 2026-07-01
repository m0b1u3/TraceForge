export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  onRetry?: (event: RetryNotice) => void;
}

export interface RetryNotice {
  label: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, "signal" | "onRetry"> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2000,
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NETWORK_PATTERNS = [
  "fetch failed",
  "econnreset",
  "etimedout",
  "enotfound",
  "econnrefused",
  "socket hang up",
  "network",
];

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const maybe = error as { name?: unknown; code?: unknown; message?: unknown };
  return maybe.name === "AbortError"
    || maybe.code === "ABORT_ERR"
    || String(maybe.message ?? "").toLowerCase().includes("aborted");
}

export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof SyntaxError) return false;
  const maybe = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status = typeof maybe.status === "number"
    ? maybe.status
    : typeof maybe.statusCode === "number"
      ? maybe.statusCode
      : undefined;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const message = String(maybe.message ?? maybe.code ?? "").toLowerCase();
  return NETWORK_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
): Promise<T> {
  const merged: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  if (merged.signal?.aborted) throw new DOMException("aborted", "AbortError");

  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    if (merged.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (merged.signal?.aborted || !isRetryableError(error) || attempt >= merged.maxAttempts) throw error;
      merged.onRetry?.({ label, attempt: attempt + 1, maxAttempts: merged.maxAttempts, reason: errorReason(error) });
      await sleep(delayFor(attempt, merged), merged.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function delayFor(failedAttempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1), policy.maxDelayMs);
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
