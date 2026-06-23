import type { RuntimeEvent } from "@traceforge/shared";

export class EventBus {
  private subs = new Set<(e: RuntimeEvent) => void>();

  emit(event: RuntimeEvent): void {
    for (const fn of this.subs) fn(event);
  }

  subscribe(fn: (e: RuntimeEvent) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
