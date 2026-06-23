import type { CandidateFact } from "@traceforge/shared";

export class CandidateStore {
  private map = new Map<string, CandidateFact>();
  put(c: CandidateFact): void {
    this.map.set(c.id, c);
  }
  get(id: string): CandidateFact | undefined {
    return this.map.get(id);
  }
  delete(id: string): boolean {
    return this.map.delete(id);
  }
}
