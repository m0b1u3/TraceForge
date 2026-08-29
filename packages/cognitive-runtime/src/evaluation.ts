import type {
  CognitiveModelRequest,
  CognitiveSnapshotModelPort,
  CognitiveSnapshotRecord,
  CompleteCognitiveSnapshotOptions,
  PrepareCognitiveSnapshotInput,
} from "./snapshot.js";

export interface CognitiveEvaluationSnapshotPort {
  prepare(input: PrepareCognitiveSnapshotInput): CognitiveSnapshotRecord;
  complete(
    id: string,
    output: unknown,
    at: string,
    options?: CompleteCognitiveSnapshotOptions,
  ): CognitiveSnapshotRecord;
  fail(id: string, error: unknown, at: string): CognitiveSnapshotRecord;
}

export interface CognitiveEvaluationInput<TDecision> {
  snapshot: Omit<PrepareCognitiveSnapshotInput, "at">;
  model: CognitiveSnapshotModelPort;
  parse(value: unknown): TDecision;
  completion?: CompleteCognitiveSnapshotOptions | ((decision: TDecision) => CompleteCognitiveSnapshotOptions);
}

/**
 * Owns only the generic evaluation lifecycle. Request construction, model routing,
 * decision parsing and completion policy remain injected by the caller.
 */
export class CognitiveEvaluationRunner {
  constructor(
    private readonly snapshots?: CognitiveEvaluationSnapshotPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run<TDecision>(input: CognitiveEvaluationInput<TDecision>): Promise<TDecision> {
    this.snapshots?.prepare({ ...input.snapshot, at: this.now() });
    try {
      const value = await input.model.extractJson(input.snapshot.request as CognitiveModelRequest);
      const decision = input.parse(value);
      const completion = typeof input.completion === "function"
        ? input.completion(decision)
        : input.completion;
      this.snapshots?.complete(input.snapshot.id, decision, this.now(), completion);
      return decision;
    } catch (error) {
      this.snapshots?.fail(input.snapshot.id, error, this.now());
      throw error;
    }
  }
}
