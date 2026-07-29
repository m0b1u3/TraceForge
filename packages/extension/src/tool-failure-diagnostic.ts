import type { ToolFailureDiagnostic } from "@traceforge/shared";

export type ToolFailureHint =
  | "authorization"
  | "rejected"
  | "policy_block"
  | "unavailable_dependency"
  | "internal";

const DIAGNOSTICS: Record<ToolFailureDiagnostic["category"], Omit<ToolFailureDiagnostic, "category">> = {
  command_exit: {
    retryable: false,
    summary: "The command completed with a non-zero exit status.",
    recommendation: "Inspect stderr and correct the command, arguments, or selected execution mechanism before trying again.",
  },
  timeout: {
    retryable: true,
    summary: "The execution did not complete within its deadline.",
    recommendation: "Retry once with bounded work or a suitable timeout; if it repeats, change the analysis approach.",
  },
  permission: {
    retryable: false,
    summary: "The execution lacks the required operating-system or filesystem permission.",
    recommendation: "Use an authorized path or tool, or obtain the required permission before retrying.",
  },
  incompatible_environment: {
    retryable: false,
    summary: "The requested operation is incompatible with the current runtime environment.",
    recommendation: "Adapt the command or use a tool supported by the current operating system and runtime.",
  },
  authorization: {
    retryable: false,
    summary: "Execution is blocked by authorization, scope, or control ownership.",
    recommendation: "Resolve the authorization or control precondition instead of repeating the same call.",
  },
  rejected: {
    retryable: false,
    summary: "The requested execution was explicitly rejected.",
    recommendation: "Respect the decision and choose a permitted alternative.",
  },
  policy_block: {
    retryable: false,
    summary: "A workbench policy prevented this execution.",
    recommendation: "Resolve the stated policy precondition or change the investigation approach.",
  },
  unavailable_dependency: {
    retryable: false,
    summary: "A required tool, service, browser session, or dependency is unavailable.",
    recommendation: "Start, install, or select an available dependency before retrying.",
  },
  network: {
    retryable: true,
    summary: "A transport or remote-service failure interrupted the execution.",
    recommendation: "Verify connectivity and retry with backoff; pivot if the failure is repeatable.",
  },
  invalid_input: {
    retryable: false,
    summary: "The tool rejected malformed or unsupported input.",
    recommendation: "Correct the input against the tool contract before retrying.",
  },
  internal: {
    retryable: true,
    summary: "The tool failed unexpectedly inside its execution boundary.",
    recommendation: "Inspect the detailed error, retry once if safe, then use an alternative implementation.",
  },
  unknown: {
    retryable: false,
    summary: "The tool reported a failure that could not be classified safely.",
    recommendation: "Inspect the raw result and choose the next action from concrete evidence rather than repeating blindly.",
  },
};

export function diagnoseToolFailure(content: string, hint?: ToolFailureHint): ToolFailureDiagnostic {
  const text = content.toLowerCase();
  const category = hint ?? classifyCategory(text);
  return { category, ...DIAGNOSTICS[category] };
}

function classifyCategory(text: string): ToolFailureDiagnostic["category"] {
  if (/\bexit=(?!(?:0)(?:\D|$))-?\d+\b/i.test(text)) return "command_exit";
  if (hasAny(text, ["timeout", "timed out", "etimedout", "gateway timeout"])) return "timeout";
  if (hasAny(text, ["permission denied", "eacces", "eperm", "access is denied"])) return "permission";
  if (hasAny(text, [
    "command rejected before execution",
    "not recognized as an internal or external command",
    "is not recognized as the name of a cmdlet",
    "unsupported option",
    "unsupported platform",
  ])) return "incompatible_environment";
  if (hasAny(text, ["out of scope", "scope guard", "not authorized", "human control", "handoff"])) return "authorization";
  if (hasAny(text, ["invalid input", "invalid argument", "schema", "validation failed", "malformed", "unsupported input"])) return "invalid_input";
  if (hasAny(text, [
    "econnreset", "econnrefused", "enotfound", "eai_again", "socket hang up",
    "temporary failure in name resolution", "network", "bad gateway", "service unavailable",
    "too many requests", "rate limit", "empty reply from server",
  ])) return "network";
  if (hasAny(text, [
    "browser not started", "no browser session", "unknown mcp server", "mcp server",
    "command not found", "module not found", "tool not found", "enoent", "cannot find", "missing dependency",
  ])) return "unavailable_dependency";
  if (hasAny(text, ["tool_error", "spawn failed", "exception", "internal error"])) return "internal";
  return "unknown";
}

function hasAny(text: string, candidates: string[]): boolean {
  return candidates.some((candidate) => text.includes(candidate));
}
