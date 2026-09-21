export interface LongTaskPolicy { segmentTurns: number; maximumTurns?: number; maximumDurationMs?: number }
export interface LongTaskState { policy: LongTaskPolicy; startedAt: string; loopGuard?: { fingerprint: string; repeats: number } }
export function validateLongTaskPolicy(value: LongTaskPolicy): LongTaskPolicy {
  if (!value || Object.keys(value).some(key => !["segmentTurns", "maximumTurns", "maximumDurationMs"].includes(key))
    || !Number.isSafeInteger(value.segmentTurns) || value.segmentTurns < 1 || value.segmentTurns > 100
    || value.maximumTurns !== undefined && (!Number.isSafeInteger(value.maximumTurns) || value.maximumTurns < value.segmentTurns)
    || value.maximumDurationMs !== undefined && (!Number.isSafeInteger(value.maximumDurationMs) || value.maximumDurationMs < 1000))
    throw new Error("Invalid long task policy");
  return { segmentTurns: value.segmentTurns, maximumTurns: value.maximumTurns, maximumDurationMs: value.maximumDurationMs };
}
