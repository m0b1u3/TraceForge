export interface PendingApproval {
  approvalId: string;
  tool: string;
  input: string;
}

export interface PendingScope {
  host: string;
  reason: string;
}

export interface PendingInterventions {
  approval: PendingApproval | null;
  scope: PendingScope | null;
}

export class PendingInterventionRegistry {
  private approvals = new Map<string, PendingApproval>();
  private scopes = new Map<string, PendingScope>();

  get(caseId: string): PendingInterventions {
    return {
      approval: this.approvals.get(caseId) ?? null,
      scope: this.scopes.get(caseId) ?? null,
    };
  }

  setApproval(caseId: string, approval: PendingApproval): void {
    this.approvals.set(caseId, approval);
  }

  clearApproval(caseId: string, approvalId: string): void {
    if (this.approvals.get(caseId)?.approvalId === approvalId) this.approvals.delete(caseId);
  }

  setScope(caseId: string, scope: PendingScope): void {
    this.scopes.set(caseId, scope);
  }

  clearScope(caseId: string, host: string): void {
    if (this.scopes.get(caseId)?.host === host) this.scopes.delete(caseId);
  }

  clearCase(caseId: string): void {
    this.approvals.delete(caseId);
    this.scopes.delete(caseId);
  }
}
