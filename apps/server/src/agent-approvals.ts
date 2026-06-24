type Decision = "approved" | "rejected";

export class ApprovalRegistry {
  private pending = new Map<string, (d: Decision) => void>();

  request(approvalId: string): Promise<Decision> {
    return new Promise((resolve) => {
      this.pending.set(approvalId, resolve);
    });
  }

  resolve(approvalId: string, decision: Decision): boolean {
    const fn = this.pending.get(approvalId);
    if (!fn) return false;
    this.pending.delete(approvalId);
    fn(decision);
    return true;
  }
}
