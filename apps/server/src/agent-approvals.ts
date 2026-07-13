type Decision = "approved" | "rejected";

export class ApprovalRegistry {
  private pending = new Map<string, (d: Decision) => void>();

  request(approvalId: string, signal?: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: Decision) => {
        if (settled) return;
        settled = true;
        this.pending.delete(approvalId);
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = () => finish("rejected");

      this.pending.set(approvalId, finish);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  resolve(approvalId: string, decision: Decision): boolean {
    const fn = this.pending.get(approvalId);
    if (!fn) return false;
    fn(decision);
    return true;
  }
}
