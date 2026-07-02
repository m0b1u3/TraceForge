import type { Case, TrafficEntry, Fact, Task, TimelineEntry, ObserverWarning, AgentEvent, AgentRun } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";

/** 对会改状态的请求统一检查 r.ok：失败时抛带后端原因的错误，供调用方提示用户。 */
async function ensureOk(r: Response, action: string): Promise<Response> {
  if (r.ok) return r;
  let reason = `${r.status}`;
  try {
    const body = await r.json();
    reason = body.reason || body.error || reason;
  } catch { /* 非 JSON 响应，保留状态码 */ }
  throw new Error(`${action}失败：${reason}`);
}

export async function createCase(name: string, allowHosts: string[]): Promise<Case> {
  const r = await fetch("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, allowHosts }),
  });
  await ensureOk(r, "创建 Case");
  return r.json();
}

export async function startBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/start`, { method: "POST" }), "启动浏览器");
}
export async function stopBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/stop`, { method: "POST" }), "停止浏览器");
}
export async function takeoverBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/takeover`, { method: "POST" }), "接管浏览器");
}
export async function releaseBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/release`, { method: "POST" }), "交回控制权");
}

export async function listTraffic(caseId: string): Promise<TrafficEntry[]> {
  const r = await fetch(`/api/cases/${caseId}/traffic`);
  return r.json();
}

export async function createFact(
  caseId: string,
  input: Omit<Fact, "id" | "caseId" | "createdAt" | "confidence" | "tags"> &
    Partial<Pick<Fact, "confidence" | "tags">>,
): Promise<Fact> {
  const r = await fetch(`/api/cases/${caseId}/facts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(r, "创建 Fact");
  return r.json();
}

export async function listFacts(caseId: string): Promise<Fact[]> {
  return (await fetch(`/api/cases/${caseId}/facts`)).json();
}

export async function createTask(
  caseId: string,
  input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">,
): Promise<Task> {
  const r = await fetch(`/api/cases/${caseId}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(r, "创建 Task");
  return r.json();
}

export async function listTasks(caseId: string): Promise<Task[]> {
  return (await fetch(`/api/cases/${caseId}/tasks`)).json();
}

export async function patchTask(taskId: string, status: Task["status"], reason?: string): Promise<Task> {
  const r = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, reason }),
  });
  await ensureOk(r, "更新 Task 状态");
  return r.json();
}

export async function listTimeline(caseId: string): Promise<TimelineEntry[]> {
  return (await fetch(`/api/cases/${caseId}/timeline`)).json();
}

export async function runAgent(caseId: string, goal: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/cases/${caseId}/agent/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }),
  }), "运行 Agent");
  return (await r.json()).run;
}

export async function steerAgentRun(runId: string, content: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/agent/runs/${runId}/steer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
  }), "补充指令");
  return (await r.json()).run;
}

export async function interruptAgentRun(runId: string, reason?: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/agent/runs/${runId}/interrupt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
  }), "停止 Agent");
  return (await r.json()).run;
}

export async function getActiveAgentRun(caseId: string): Promise<AgentRun | null> {
  return (await fetch(`/api/cases/${caseId}/agent/runs/active`)).json();
}

export async function resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
  await ensureOk(await fetch(`/api/agent/approvals/${approvalId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
  }), "提交审批");
}

export async function listCases(): Promise<Case[]> {
  return (await fetch("/api/cases")).json();
}

export async function listMcpTools(): Promise<McpToolHandle[]> {
  return (await fetch("/api/mcp/tools")).json();
}

export async function listWarnings(caseId: string): Promise<ObserverWarning[]> {
  return (await fetch(`/api/cases/${caseId}/warnings`)).json();
}

export async function acceptObserverWarning(warningId: string): Promise<ObserverWarning> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/accept`, { method: "POST" }), "继续 Observer 提示");
  return r.json();
}

export async function dismissObserverWarning(warningId: string): Promise<ObserverWarning> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/dismiss`, { method: "POST" }), "忽略 Observer 提示");
  return r.json();
}

export async function convertObserverWarningToTask(warningId: string): Promise<{ warning: ObserverWarning; task: Task }> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/convert-task`, { method: "POST" }), "创建 Observer Task");
  return r.json();
}

export async function listAgentEvents(caseId: string): Promise<AgentEvent[]> {
  return (await fetch(`/api/cases/${caseId}/agent/events`)).json();
}

export async function approveScope(caseId: string, host: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/scope/approve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host }),
  }), "纳入授权范围");
}
