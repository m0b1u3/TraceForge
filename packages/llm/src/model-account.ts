import type { ModelCredentialResolver } from "./connections.js";

/** Public login challenge; never includes tokens or private device codes. */
export interface ModelLoginChallenge {
  pendingId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}

/** Account capability injected by the host composition layer. */
export interface ModelAccountConnection extends ModelCredentialResolver {
  begin(signal?: AbortSignal): Promise<ModelLoginChallenge>;
  poll(pendingId: string, account: string, signal?: AbortSignal): Promise<"pending" | "connected">;
  cancel(pendingId: string): void;
  cancelAll(): void;
  status(account: string): Promise<"signed_out" | "connected" | "refresh_required">;
  disconnect(account: string): Promise<void>;
}
export interface ModelAccountBinding {
  id: string;
  connection: ModelAccountConnection;
}
