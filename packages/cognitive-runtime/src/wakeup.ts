export type BlackboardChange =
  | {
      kind: "run";
      runId: string;
      caseId: string;
      revision: number;
      eventTypes: string[];
      at: string;
    }
  | {
      kind: "graph";
      caseId: string;
      revision: number;
      eventTypes: string[];
      at: string;
    };

export type BlackboardChangeListener = (change: BlackboardChange) => void;

/**
 * In-process hint channel for committed Blackboard changes. Durable stores remain
 * authoritative; listener failures cannot invalidate an already committed change.
 */
export class BlackboardChangeBus {
  private readonly listeners = new Set<BlackboardChangeListener>();

  subscribe(listener: BlackboardChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(change: BlackboardChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // Wake-up hints are isolated from durable event commits.
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export interface CognitiveContextCursorAdvance {
  consumer: string;
  runId: string;
  semanticFingerprint: string;
  sourceRunRevision: number;
  sourceGraphRevision: number;
  at: string;
}

export interface CognitiveContextCursorPort {
  cursor(consumer: string, runId: string): string | undefined;
  advance(input: CognitiveContextCursorAdvance): void;
}

/** Semantic deduplication independent from timers, persistence and evaluation policy. */
export class CognitiveWakeGate {
  private readonly volatileCursors = new Map<string, string>();

  constructor(private readonly cursors?: CognitiveContextCursorPort) {}

  shouldEvaluate(consumer: string, runId: string, semanticFingerprint: string): boolean {
    return this.current(consumer, runId) !== semanticFingerprint;
  }

  advance(input: CognitiveContextCursorAdvance): void {
    if (this.cursors) {
      this.cursors.advance(input);
      return;
    }
    this.volatileCursors.set(this.key(input.consumer, input.runId), input.semanticFingerprint);
  }

  private current(consumer: string, runId: string): string | undefined {
    return this.cursors?.cursor(consumer, runId) ?? this.volatileCursors.get(this.key(consumer, runId));
  }

  private key(consumer: string, runId: string): string {
    return `${consumer}\u0000${runId}`;
  }
}
