import { parseDesktopExecutionOperation } from "@traceforge/shared/desktop-execution";
export type { DesktopExecutionOperation as ExecutionOperation } from "@traceforge/shared/desktop-execution";
import type { DesktopExecutionOperation as ExecutionOperation } from "@traceforge/shared/desktop-execution";
export function readExecutionJournal(storage: Pick<Storage, "getItem">, conversationId: string): ExecutionOperation | null {
  const raw = storage.getItem(`traceforge.execution.${conversationId}`);
  if (raw === null) return null;
  if (raw.length > 40000) throw new Error("Invalid execution journal");
  return parseDesktopExecutionOperation(JSON.parse(raw), conversationId);
}
