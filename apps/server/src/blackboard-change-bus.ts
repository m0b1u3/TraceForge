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
 * In-process wake-up channel for committed Blackboard changes.
 *
 * SQLite remains the source of truth. Notifications are deliberately emitted
 * only after a transaction commits and contain no mutable investigation data;
 * consumers reload their own bounded snapshot from the durable stores.
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
        // A notification listener cannot roll back or invalidate a committed event.
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
