import { resolve, join, sep } from "node:path";

export function resolveInWorkspace(workspaceRoot: string, caseId: string, relPath = "."): string {
  if (!caseId || caseId.includes("/") || caseId.includes("\\") || caseId === "." || caseId === "..") {
    throw new Error(`invalid caseId: ${caseId}`);
  }
  const caseRoot = resolve(workspaceRoot, caseId);
  const target = resolve(caseRoot, relPath);
  if (target !== caseRoot && !target.startsWith(caseRoot + sep)) {
    throw new Error("path escapes workspace");
  }
  return relPath === "." ? caseRoot : join(caseRoot, relPath);
}

export function truncateOutput(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  return `${head}\n…[truncated ${buf.byteLength - maxBytes} bytes]`;
}
