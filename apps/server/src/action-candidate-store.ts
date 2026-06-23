import type { ActionCard } from "@traceforge/shared";

export class ActionCandidateStore {
  private map = new Map<string, ActionCard>();
  put(a: ActionCard): void {
    this.map.set(a.id, a);
  }
  get(id: string): ActionCard | undefined {
    return this.map.get(id);
  }
  delete(id: string): boolean {
    return this.map.delete(id);
  }
}
