import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent, Case, ObserverWarning, AgentRun, AgentRunUsage, AttackPath, IdentityContext, SecurityReport, ValidationWorkflowSnapshot } from "@traceforge/shared";
import { validationTimelineConsoleEvent } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";
import { listTraffic, clearTraffic as clearTrafficApi, listFacts, listTasks, listTimeline, listMcpTools, listWarnings, listAgentEvents, getLlmConfig, updateLlmConfig, testLlmConfig, deleteCase as deleteCaseApi, getActiveAgentRun, getLatestAgentRun, getPendingInterventions, getAgentRunUsage, getBrowserState, listAttackPaths, listIdentities, listSecurityReports, getValidationWorkflow } from "./api.js";
import type { LlmConfig, LlmConfigInput } from "./api.js";
import type { ValidationSyncState } from "./lib/validation-presentation.js";

export interface AgentUiEvent {
  kind: "user" | "text" | "reasoning" | "tool_call" | "tool_result" | "validation" | "done" | "error" | "started";
  text: string;
  tool?: string | null;
  createdAt?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function isRunBusy(run: AgentRun | null): boolean {
  return run ? ["queued", "running", "interrupting"].includes(run.status) : false;
}

function runTokenUsage(run: AgentRun): TokenUsage {
  return {
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    totalTokens: run.totalTokens,
  };
}

export interface ObserverTelemetry {
  reviewCount: number;
  correctionCount: number;
  failureCount: number;
  totalTokens: number;
  lastTrigger: "interval" | "final" | "repeated_failure" | "high_risk" | "evidence_conflict" | "finding_verification" | null;
  lastDurationMs: number | null;
}

const EMPTY_OBSERVER_TELEMETRY: ObserverTelemetry = {
  reviewCount: 0,
  correctionCount: 0,
  failureCount: 0,
  totalTokens: 0,
  lastTrigger: null,
  lastDurationMs: null,
};

export function observerTelemetryFromHistory(
  usage: AgentRunUsage[],
  warnings: ObserverWarning[],
): ObserverTelemetry {
  const observerUsage = usage.filter((entry) => entry.source === "observer");
  return {
    ...EMPTY_OBSERVER_TELEMETRY,
    reviewCount: observerUsage.length,
    correctionCount: warnings.filter((warning) => warning.occurrenceCount >= 2).length,
    totalTokens: observerUsage.reduce((sum, entry) => sum + entry.totalTokens, 0),
  };
}

export type ToastTone = "info" | "success" | "error";
export type ConnectionStatus = "online" | "reconnecting" | "offline";
export type ValidationSyncStatus = ValidationSyncState;
export interface ValidationWorkflowDelta {
  revision: number;
  changedFindingIds: string[];
  leaseChanged: boolean;
  leaderChanged: boolean;
  summary: string[];
}

export function mergeValidationWorkflow(current: ValidationWorkflowSnapshot | null, incoming: ValidationWorkflowSnapshot): ValidationWorkflowSnapshot {
  if (!current || current.caseId !== incoming.caseId) return incoming;
  if (incoming.revision !== current.revision) return incoming.revision > current.revision ? incoming : current;
  return incoming.generatedAt > current.generatedAt ? incoming : current;
}

export function diffValidationWorkflow(previous: ValidationWorkflowSnapshot | null, next: ValidationWorkflowSnapshot): ValidationWorkflowDelta | null {
  if (!previous || previous.caseId !== next.caseId) return null;
  const changedFindingIds = new Set<string>();
  const summary: string[] = [];
  const previousItems = new Map(previous.items.map((item) => [item.findingId, item]));
  const nextItems = new Map(next.items.map((item) => [item.findingId, item]));
  for (const item of next.items) {
    const before = previousItems.get(item.findingId);
    const label = item.findingTitle || item.findingId;
    if (!before) {
      changedFindingIds.add(item.findingId);
      summary.push(`${label} entered validation`);
      continue;
    }
    if (before.consensusStatus !== item.consensusStatus) summary.push(`${label}: ${before.consensusStatus} → ${item.consensusStatus}`);
    else if (before.findingStatus !== item.findingStatus) summary.push(`${label}: finding ${before.findingStatus ?? "unknown"} → ${item.findingStatus ?? "unknown"}`);
    else if (before.completionReady !== item.completionReady) summary.push(`${label}: evidence gate ${item.completionReady ? "satisfied" : "reopened"}`);
    else if (before.missingEvidence.join("\u0000") !== item.missingEvidence.join("\u0000")) summary.push(`${label}: evidence gaps ${before.missingEvidence.length} → ${item.missingEvidence.length}`);
    else if (before.priorityScore !== item.priorityScore) summary.push(`${label}: priority ${before.priorityScore ?? "—"} → ${item.priorityScore ?? "—"}`);
    else if (before.taskStatus !== item.taskStatus) summary.push(`${label}: task ${before.taskStatus ?? "none"} → ${item.taskStatus ?? "none"}`);
    else if (before.confidence !== item.confidence) summary.push(`${label}: confidence ${Math.round(before.confidence * 100)}% → ${Math.round(item.confidence * 100)}%`);
    else continue;
    changedFindingIds.add(item.findingId);
  }
  for (const item of previous.items) {
    if (!nextItems.has(item.findingId)) {
      changedFindingIds.add(item.findingId);
      summary.push(`${item.findingTitle || item.findingId} left validation`);
    }
  }
  const leaseChanged = previous.runningLease !== next.runningLease;
  const leaderChanged = previous.leader?.taskId !== next.leader?.taskId || previous.leader?.score !== next.leader?.score;
  if (leaderChanged) summary.unshift(next.leader ? `Priority leader changed · score ${next.leader.score}` : "Priority leader cleared");
  if (leaseChanged) summary.unshift(next.runningLease ? "Validation lease claimed" : "Validation lease released");
  if (!leaseChanged && !leaderChanged && changedFindingIds.size === 0) return null;
  return { revision: next.revision, changedFindingIds: [...changedFindingIds], leaseChanged, leaderChanged, summary };
}
export interface ToastNotice {
  id: number;
  message: string;
  tone: ToastTone;
}

function inferToastTone(message: string): ToastTone {
  const normalized = message.toLowerCase();
  if (/failed|failure|error|unable|could not|cannot|denied|invalid/.test(normalized)) return "error";
  if (/saved|success|deleted|started|copied|connected/.test(normalized)) return "success";
  return "info";
}

let disconnectActiveWebSocket: (() => void) | null = null;
let toastSequence = 0;
let streamDeltaTimer: ReturnType<typeof setTimeout> | null = null;
const pendingStreamDeltas = new Map<string, string>();

export const CLIENT_TRAFFIC_LIMIT = 5_000;
export const CLIENT_TIMELINE_LIMIT = 3_000;
export const CLIENT_AGENT_EVENT_LIMIT = 5_000;

export function takeRecent<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

function appendAgentUiEvent(
  agentEvents: AgentUiEvent[],
  streamingMessages: Record<string, number>,
  event: AgentUiEvent,
) {
  const nextEvents = takeRecent([...agentEvents, event], CLIENT_AGENT_EVENT_LIMIT);
  const removed = agentEvents.length + 1 - nextEvents.length;
  if (removed === 0) return { agentEvents: nextEvents, streamingMessages };
  return {
    agentEvents: nextEvents,
    streamingMessages: Object.fromEntries(
      Object.entries(streamingMessages)
        .map(([messageId, index]) => [messageId, index - removed] as const)
        .filter(([, index]) => index >= 0),
    ),
  };
}

function cancelPendingStreamDeltas(messageId?: string) {
  if (messageId) pendingStreamDeltas.delete(messageId);
  else pendingStreamDeltas.clear();
  if (pendingStreamDeltas.size === 0 && streamDeltaTimer) {
    clearTimeout(streamDeltaTimer);
    streamDeltaTimer = null;
  }
}

function flushPendingStreamDeltas() {
  streamDeltaTimer = null;
  if (pendingStreamDeltas.size === 0) return;
  const deltas = new Map(pendingStreamDeltas);
  pendingStreamDeltas.clear();
  useStore.setState((state) => {
    let events: typeof state.agentEvents | null = null;
    for (const [messageId, delta] of deltas) {
      const index = state.streamingMessages[messageId];
      if (index === undefined) continue;
      const current = (events ?? state.agentEvents)[index];
      if (!current) continue;
      events ??= state.agentEvents.slice();
      events[index] = { ...current, text: current.text + delta };
    }
    return events ? { agentEvents: events } : {};
  });
}

function queueStreamDelta(messageId: string, delta: string) {
  pendingStreamDeltas.set(messageId, (pendingStreamDeltas.get(messageId) ?? "") + delta);
  streamDeltaTimer ??= setTimeout(flushPendingStreamDeltas, 16);
}

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  identities: IdentityContext[];
  attackPaths: AttackPath[];
  securityReports: SecurityReport[];
  facts: Fact[];
  tasks: Task[];
  timeline: TimelineEntry[];
  actions: ActionCard[];
  decisions: Decision[];
  agentEvents: AgentUiEvent[];
  agentBusy: boolean;
  activeRun: AgentRun | null;
  continuationRun: AgentRun | null;
  streamingMessages: Record<string, number>;
  streamedAgentTexts: string[];
  tokenUsage: TokenUsage;
  tokenUsageHistory: AgentRunUsage[];
  connectionStatus: ConnectionStatus;
  setAgentBusy: (b: boolean) => void;
  setActiveRun: (run: AgentRun | null) => void;
  setContinuationRun: (run: AgentRun | null) => void;
  setTokenUsage: (usage: TokenUsage) => void;
  toast: ToastNotice | null;
  showToast: (msg: string, tone?: ToastTone) => void;
  pendingApproval: { approvalId: string; tool: string; input: string } | null;
  browserController: "llm" | "human" | null;
  browserUrl: string;
  selectedTrafficId: string | null;
  selectedTrafficSnapshot: TrafficEntry | null;
  selectedFactId: string | null;
  selectedAgentEvent: { kind: "tool_call" | "tool_result"; label: string; text: string } | null;
  inspectorMode: "overview" | "traffic" | "finding";
  cases: Case[];
  activeTab: "facts" | "tasks" | "timeline" | "mcp" | "graph" | "observer" | "reports";
  graphModalOpen: boolean;
  mcpTools: McpToolHandle[];
  warnings: ObserverWarning[];
  observerTelemetry: ObserverTelemetry;
  validationWorkflow: ValidationWorkflowSnapshot | null;
  validationWorkflowDelta: ValidationWorkflowDelta | null;
  validationSyncStatus: ValidationSyncStatus;
  knowledgeTarget: { kind: "task" | "finding"; id: string; requestId: number } | null;
  navigateToKnowledge: (target: { kind: "task" | "finding"; id: string }) => void;
  clearKnowledgeTarget: (requestId: number) => void;
  refreshValidationWorkflow: () => Promise<void>;
  llmConfig: LlmConfig | null;
  settingsModalOpen: boolean;
  setLlmConfig: (cfg: LlmConfig | null) => void;
  setSettingsModalOpen: (open: boolean) => void;
  loadLlmConfig: () => Promise<void>;
  saveLlmConfig: (input: LlmConfigInput) => Promise<void>;
  testLlmConfig: (input: LlmConfigInput) => Promise<{ ok: boolean; message?: string; error?: string }>;
  addWarning: (w: ObserverWarning) => void;
  upsertWarning: (w: ObserverWarning) => void;
  pendingConfirmation: { runId: string; warning: ObserverWarning } | null;
  setPendingConfirmation: (p: { runId: string; warning: ObserverWarning }) => void;
  clearPendingConfirmation: () => void;
  pendingScope: { host: string; reason: string } | null;
  setPendingScope: (p: { host: string; reason: string } | null) => void;
  clearPendingScope: (host?: string) => void;
  setCase: (id: string | null) => void;
  setCases: (list: Case[]) => void;
  setActiveTab: (tab: State["activeTab"]) => void;
  setGraphModalOpen: (open: boolean) => void;
  enterCase: (id: string) => Promise<void>;
  deleteCase: (id: string) => Promise<void>;
  addEntry: (e: TrafficEntry) => void;
  upsertIdentity: (identity: IdentityContext) => void;
  upsertAttackPath: (path: AttackPath) => void;
  upsertSecurityReport: (report: SecurityReport) => void;
  addFact: (f: Fact) => void;
  upsertFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  addAction: (a: ActionCard) => void;
  addDecision: (d: Decision) => void;
  addAgentEvent: (e: AgentUiEvent) => void;
  clearTraffic: () => Promise<boolean>;
  setPendingApproval: (p: { approvalId: string; tool: string; input: string }) => void;
  clearPendingApproval: (approvalId?: string) => void;
  setBrowser: (controller: "llm" | "human" | null, url?: string) => void;
  selectTraffic: (id: string | null) => void;
  inspectTraffic: (entry: TrafficEntry) => void;
  selectFact: (id: string | null) => void;
  selectAgentEvent: (event: State["selectedAgentEvent"]) => void;
  resetBrowser: () => void;
  resetAgent: () => void;
  connectWs: () => () => void;
  handleRuntimeEvent: (event: RuntimeEvent) => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  identities: [],
  attackPaths: [],
  securityReports: [],
  facts: [],
  tasks: [],
  timeline: [],
  actions: [],
  decisions: [],
  agentEvents: [],
  agentBusy: false,
  activeRun: null,
  continuationRun: null,
  streamingMessages: {},
  streamedAgentTexts: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  tokenUsageHistory: [],
  connectionStatus: "offline",
  setAgentBusy: (b) => set({ agentBusy: b }),
  setActiveRun: (run) => set({ activeRun: run, agentBusy: isRunBusy(run) }),
  setContinuationRun: (run) => set({ continuationRun: run }),
  setTokenUsage: (usage) => set({ tokenUsage: usage }),
  toast: null,
  showToast: (message, requestedTone) => {
    const tone = requestedTone ?? inferToastTone(message);
    const current = get().toast;
    if (current?.message === message && current.tone === tone) return;
    const notice = { id: ++toastSequence, message, tone };
    set({ toast: notice });
    setTimeout(() => { if (get().toast?.id === notice.id) set({ toast: null }); }, tone === "error" ? 6000 : 4000);
  },
  pendingApproval: null,
  browserController: null,
  browserUrl: "",
  selectedTrafficId: null,
  selectedTrafficSnapshot: null,
  selectedFactId: null,
  selectedAgentEvent: null,
  inspectorMode: "overview",
  cases: [],
  activeTab: "facts",
  graphModalOpen: false,
  mcpTools: [],
  warnings: [],
  observerTelemetry: { ...EMPTY_OBSERVER_TELEMETRY },
  validationWorkflow: null,
  validationWorkflowDelta: null,
  validationSyncStatus: "stale",
  knowledgeTarget: null,
  navigateToKnowledge: (target) => {
    const available = target.kind === "task"
      ? get().tasks.some((task) => task.id === target.id)
      : get().facts.some((fact) => fact.id === target.id);
    if (!available) {
      get().showToast(`Related ${target.kind} is no longer available.`, "info");
      return;
    }
    set((state) => ({
      activeTab: target.kind === "task" ? "tasks" : "facts",
      knowledgeTarget: target.kind === "task" ? { ...target, requestId: (state.knowledgeTarget?.requestId ?? 0) + 1 } : null,
      selectedFactId: target.kind === "finding" ? target.id : null,
      selectedTrafficId: null,
      selectedTrafficSnapshot: null,
      selectedAgentEvent: null,
      inspectorMode: target.kind === "finding" ? "finding" : "overview",
    }));
  },
  clearKnowledgeTarget: (requestId) => set((state) => state.knowledgeTarget?.requestId === requestId ? { knowledgeTarget: null } : {}),
  refreshValidationWorkflow: async () => {
    const caseId = get().caseId;
    if (!caseId) return;
    const runId = get().activeRun?.id;
    set({ validationSyncStatus: "recovering" });
    try {
      const snapshot = await getValidationWorkflow(caseId, runId);
      if (get().caseId === caseId) set((state) => ({ validationWorkflow: mergeValidationWorkflow(state.validationWorkflow, snapshot), validationSyncStatus: "live" }));
    } catch (error) {
      if (get().caseId === caseId) set({ validationSyncStatus: "stale" });
      throw error;
    }
  },
  llmConfig: null,
  settingsModalOpen: false,
  setLlmConfig: (cfg) => set({ llmConfig: cfg }),
  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
  loadLlmConfig: async () => {
    try {
      const cfg = await getLlmConfig();
      set({ llmConfig: cfg });
    } catch (err) {
      get().showToast(`Failed to load settings: ${(err as Error).message}`);
    }
  },
  saveLlmConfig: async (input) => {
    try {
      const cfg = await updateLlmConfig(input);
      set({ llmConfig: cfg });
      get().showToast("Settings saved", "success");
    } catch (err) {
      get().showToast(`Failed to save settings: ${(err as Error).message}`);
      throw err;
    }
  },
  testLlmConfig: async (input) => {
    try {
      const result = await testLlmConfig(input);
      if (result.ok) {
        get().showToast(result.message ?? "Connection successful", "success");
      } else {
        get().showToast(`Connection failed: ${result.error ?? "unknown error"}`);
      }
      return result;
    } catch (err) {
      const message = `Connection test failed: ${(err as Error).message}`;
      get().showToast(message);
      return { ok: false, error: message };
    }
  },
  addWarning: (w) => set((s) => ({ warnings: [...s.warnings, w] })),
  upsertWarning: (w) =>
    set((s) => {
      const i = s.warnings.findIndex((x) => x.id === w.id);
      if (i === -1) return { warnings: [...s.warnings, w] };
      const copy = s.warnings.slice();
      copy[i] = w;
      return { warnings: copy };
    }),
  pendingConfirmation: null,
  setPendingConfirmation: (p) => set({ pendingConfirmation: p }),
  clearPendingConfirmation: () => set({ pendingConfirmation: null }),
  pendingScope: null,
  setPendingScope: (p) => set({ pendingScope: p }),
  clearPendingScope: (host) => set((s) => (
    !host || s.pendingScope?.host === host ? { pendingScope: null } : {}
  )),
  setCase: (id) => {
    cancelPendingStreamDeltas();
    set({ caseId: id, traffic: [], identities: [], attackPaths: [], securityReports: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], agentBusy: false, activeRun: null, continuationRun: null, streamingMessages: {}, streamedAgentTexts: [], tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, tokenUsageHistory: [], pendingApproval: null, browserController: null, browserUrl: "", selectedTrafficId: null, selectedTrafficSnapshot: null, selectedFactId: null, selectedAgentEvent: null, inspectorMode: "overview", warnings: [], observerTelemetry: { ...EMPTY_OBSERVER_TELEMETRY }, validationWorkflow: null, validationWorkflowDelta: null, validationSyncStatus: id ? "recovering" : "stale", knowledgeTarget: null, pendingScope: null, pendingConfirmation: null });
  },
  setCases: (list) => set({ cases: list }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setGraphModalOpen: (open) => set({ graphModalOpen: open }),
  enterCase: async (id) => {
    get().setCase(id);
    const [traffic, identities, attackPaths, securityReports, facts, tasks, timeline, mcpTools, warnings, agentEvents, activeRun, pendingInterventions, browserState, validationWorkflow] = await Promise.all([
      listTraffic(id, { limit: CLIENT_TRAFFIC_LIMIT }), listIdentities(id), listAttackPaths(id), listSecurityReports(id), listFacts(id), listTasks(id),
      listTimeline(id, { limit: CLIENT_TIMELINE_LIMIT }), listMcpTools(), listWarnings(id),
      listAgentEvents(id, { limit: CLIENT_AGENT_EVENT_LIMIT }), getActiveAgentRun(id),
      getPendingInterventions(id), getBrowserState(id), getValidationWorkflow(id),
    ]);
    const latestRun = activeRun ?? await getLatestAgentRun(id);
    const tokenUsageHistory = latestRun ? await getAgentRunUsage(latestRun.id) : [];
    if (get().caseId !== id) return;
    set({
      traffic: takeRecent(traffic, CLIENT_TRAFFIC_LIMIT),
      identities,
      attackPaths,
      securityReports,
      facts,
      tasks,
      timeline: takeRecent(timeline, CLIENT_TIMELINE_LIMIT),
      mcpTools,
      warnings,
      agentEvents: takeRecent(agentEvents.map((e) => ({ kind: e.kind, text: e.text, tool: e.tool, createdAt: e.createdAt })), CLIENT_AGENT_EVENT_LIMIT),
      activeRun,
      continuationRun: latestRun?.status === "needs_continuation" ? latestRun : null,
      agentBusy: isRunBusy(activeRun),
      tokenUsage: latestRun ? runTokenUsage(latestRun) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      tokenUsageHistory,
      observerTelemetry: observerTelemetryFromHistory(tokenUsageHistory, warnings),
      validationWorkflow,
      validationSyncStatus: "live",
      pendingApproval: pendingInterventions.approval,
      pendingScope: pendingInterventions.scope,
      browserController: browserState.controller,
      browserUrl: browserState.url ?? "",
    });
  },
  deleteCase: async (id) => {
    await deleteCaseApi(id);
    const isCurrent = get().caseId === id;
    set((s) => ({
      cases: s.cases.filter((c) => c.id !== id),
      ...(isCurrent
        ? {
            caseId: null,
            traffic: [],
            identities: [],
            attackPaths: [],
            securityReports: [],
            facts: [],
            tasks: [],
            timeline: [],
            actions: [],
            decisions: [],
            agentEvents: [],
            warnings: [],
            activeRun: null,
            agentBusy: false,
            browserController: null,
            browserUrl: "",
            selectedTrafficId: null,
            selectedTrafficSnapshot: null,
            selectedFactId: null,
            selectedAgentEvent: null,
            inspectorMode: "overview" as const,
            pendingApproval: null,
            pendingScope: null,
            pendingConfirmation: null,
          }
        : {}),
    }));
    get().showToast("Case deleted");
  },
  addEntry: (e) => set((s) => {
    const index = s.traffic.findIndex((entry) => entry.id === e.id);
    if (index < 0) {
      const traffic = takeRecent([...s.traffic, e], CLIENT_TRAFFIC_LIMIT);
      const selectionExpired = Boolean(s.selectedTrafficId) && !traffic.some((entry) => entry.id === s.selectedTrafficId);
      return {
        traffic,
        ...(selectionExpired ? { selectedTrafficId: null, selectedTrafficSnapshot: null, inspectorMode: "overview" as const } : {}),
      };
    }
    const traffic = [...s.traffic];
    traffic[index] = { ...traffic[index], ...e };
    return { traffic };
  }),
  upsertIdentity: (identity) => set((state) => {
    const index = state.identities.findIndex((item) => item.id === identity.id);
    if (index === -1) return { identities: [...state.identities, identity] };
    const identities = state.identities.slice();
    identities[index] = identity;
    return { identities };
  }),
  upsertAttackPath: (path) => set((state) => {
    const index = state.attackPaths.findIndex((item) => item.id === path.id);
    if (index === -1) return { attackPaths: [path, ...state.attackPaths] };
    const attackPaths = state.attackPaths.slice();
    attackPaths[index] = path;
    return { attackPaths };
  }),
  upsertSecurityReport: (report) => set((state) => {
    const index = state.securityReports.findIndex((item) => item.id === report.id);
    if (index === -1) return { securityReports: [report, ...state.securityReports] };
    const securityReports = state.securityReports.slice();
    securityReports[index] = report;
    return { securityReports };
  }),
  addFact: (f) => set((s) => ({ facts: [...s.facts, f] })),
  upsertFact: (f) =>
    set((s) => {
      const i = s.facts.findIndex((x) => x.id === f.id);
      if (i === -1) return { facts: [...s.facts, f] };
      const copy = s.facts.slice();
      copy[i] = f;
      return { facts: copy };
    }),
  upsertTask: (t) =>
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      if (i === -1) return { tasks: [...s.tasks, t] };
      const copy = s.tasks.slice();
      copy[i] = t;
      return { tasks: copy };
    }),
  addTimeline: (e) => set((s) => ({ timeline: takeRecent([...s.timeline, e], CLIENT_TIMELINE_LIMIT) })),
  addAction: (a) => set((s) => ({ actions: [...s.actions, a] })),
  addDecision: (d) => set((s) => ({ decisions: [...s.decisions, d] })),
  addAgentEvent: (e) => set((s) => appendAgentUiEvent(s.agentEvents, s.streamingMessages, e)),
  clearTraffic: async () => {
    const caseId = get().caseId;
    if (!caseId) return false;
    try {
      await clearTrafficApi(caseId);
    } catch {
      get().showToast("Unable to clear traffic", "error");
      return false;
    }
    if (get().caseId !== caseId) return false;
    set((state) => ({ traffic: [], selectedTrafficId: null, selectedTrafficSnapshot: null, ...(state.selectedTrafficId ? { inspectorMode: "overview" as const } : {}) }));
    get().showToast("Traffic cleared");
    return true;
  },
  setPendingApproval: (p) => set({ pendingApproval: p }),
  clearPendingApproval: (approvalId) => set((s) => (
    !approvalId || s.pendingApproval?.approvalId === approvalId ? { pendingApproval: null } : {}
  )),
  setBrowser: (controller, url) => set((s) => ({ browserController: controller, browserUrl: url ?? s.browserUrl })),
  selectTraffic: (id) => set({ selectedTrafficId: id, selectedTrafficSnapshot: null, selectedFactId: null, selectedAgentEvent: null, inspectorMode: id ? "traffic" : "overview" }),
  inspectTraffic: (entry) => set({ selectedTrafficId: entry.id, selectedTrafficSnapshot: entry, selectedFactId: null, selectedAgentEvent: null, inspectorMode: "traffic" }),
  selectFact: (id) => set({ selectedFactId: id, selectedTrafficId: null, selectedTrafficSnapshot: null, selectedAgentEvent: null, inspectorMode: id ? "finding" : "overview" }),
  selectAgentEvent: (event) => set({ selectedAgentEvent: event, selectedTrafficId: null, selectedTrafficSnapshot: null, selectedFactId: null, inspectorMode: event ? "finding" : "overview" }),
  resetBrowser: () => set({ browserController: null, browserUrl: "" }),
  resetAgent: () => {
    cancelPendingStreamDeltas();
    set({ agentEvents: [], pendingApproval: null, activeRun: null, continuationRun: null, streamingMessages: {}, streamedAgentTexts: [], agentBusy: false });
  },
  connectWs: () => {
    disconnectActiveWebSocket?.();
    set({ connectionStatus: "reconnecting" });

    let disposed = false;
    let retry = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const disconnect = () => {
      disposed = true;
      cancelPendingStreamDeltas();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      if (current && current.readyState < WebSocket.CLOSING) current.close();
      if (disconnectActiveWebSocket === disconnect) disconnectActiveWebSocket = null;
      set({ connectionStatus: "offline", validationSyncStatus: "stale" });
    };

    const open = () => {
      if (disposed) return;
      const ws = new WebSocket(`ws://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        retry = 0;
        set({ connectionStatus: "online", validationSyncStatus: "recovering" });
        const caseId = get().caseId;
        if (!caseId) return;
        void Promise.all([listTraffic(caseId, { limit: CLIENT_TRAFFIC_LIMIT }), getBrowserState(caseId), getValidationWorkflow(caseId, get().activeRun?.id)])
          .then(([traffic, browserState, validationWorkflow]) => {
            if (disposed || socket !== ws || get().caseId !== caseId) return;
            const clientTraffic = takeRecent(traffic, CLIENT_TRAFFIC_LIMIT);
            set((state) => ({
              traffic: clientTraffic,
              browserController: browserState.controller,
              browserUrl: browserState.url ?? "",
              validationWorkflow: mergeValidationWorkflow(state.validationWorkflow, validationWorkflow),
              validationSyncStatus: "live",
              ...(!state.selectedTrafficId || clientTraffic.some((entry) => entry.id === state.selectedTrafficId)
                ? {}
                : { selectedTrafficId: null, selectedTrafficSnapshot: null, inspectorMode: "overview" as const }),
            }));
          })
          .catch(() => {
            if (!disposed && socket === ws) get().showToast("Unable to resync runtime state", "error");
          });
      };
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        set({ connectionStatus: globalThis.navigator?.onLine === false ? "offline" : "reconnecting", validationSyncStatus: globalThis.navigator?.onLine === false ? "stale" : "recovering" });
        const delay = Math.min(1000 * 2 ** retry, 10000);
        retry += 1;
        reconnectTimer = setTimeout(open, delay);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = onMessage;
    };
    const onMessage = (msg: MessageEvent) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      get().handleRuntimeEvent(event);
    };
    disconnectActiveWebSocket = disconnect;
    open();
    return disconnect;
  },
  handleRuntimeEvent: (event) => {
    const cid = get().caseId;
    if ((event.type === "identity_created" || event.type === "identity_updated") && event.identity.caseId === cid) get().upsertIdentity(event.identity);
    else if ((event.type === "attack_path_created" || event.type === "attack_path_updated") && event.attackPath.caseId === cid) get().upsertAttackPath(event.attackPath);
    else if ((event.type === "security_report_created" || event.type === "security_report_updated") && event.report.caseId === cid) get().upsertSecurityReport(event.report);
    else if (event.type === "response_captured" && event.entry.caseId === cid) get().addEntry(event.entry);
    else if (event.type === "traffic_cleared" && event.caseId === cid) {
      set({ traffic: [], selectedTrafficId: null, selectedTrafficSnapshot: null, inspectorMode: "overview" });
    }
    else if (event.type === "fact_created" && event.fact.caseId === cid) get().addFact(event.fact);
    else if (event.type === "fact_updated" && event.fact.caseId === cid) get().upsertFact(event.fact);
    else if (event.type === "task_created" && event.task.caseId === cid) get().upsertTask(event.task);
    else if (event.type === "task_updated" && event.task.caseId === cid) get().upsertTask(event.task);
    else if (event.type === "timeline_appended" && event.entry.caseId === cid) {
      get().addTimeline(event.entry);
      if (validationTimelineConsoleEvent(event.entry)) get().addAgentEvent({ kind: "validation", text: event.entry.detail, tool: event.entry.eventType, createdAt: event.entry.createdAt });
    }
    else if (event.type === "validation_workflow_updated" && event.snapshot.caseId === cid) set((state) => {
      const merged = mergeValidationWorkflow(state.validationWorkflow, event.snapshot);
      return {
        validationWorkflow: merged,
        validationWorkflowDelta: merged === event.snapshot ? diffValidationWorkflow(state.validationWorkflow, event.snapshot) : state.validationWorkflowDelta,
        validationSyncStatus: "live",
      };
    });
    else if (event.type === "action_recorded" && event.action.caseId === cid) get().addAction(event.action);
    else if (event.type === "decision_recorded" && event.decision.caseId === cid) get().addDecision(event.decision);
    else if (event.type === "agent_run_started" && event.run.caseId === cid) {
      get().setActiveRun(event.run);
      get().setContinuationRun(null);
      get().setTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      set({ tokenUsageHistory: [] });
      get().addAgentEvent({ kind: "started", text: `Started: ${event.run.goal}` });
    }
    else if (event.type === "agent_stream_start" && event.caseId === cid) {
      if (get().streamingMessages[event.messageId] !== undefined) return;
      set((state) => {
        const appended = appendAgentUiEvent(state.agentEvents, state.streamingMessages, { kind: "text", text: "" });
        return {
          agentEvents: appended.agentEvents,
          streamingMessages: { ...appended.streamingMessages, [event.messageId]: appended.agentEvents.length - 1 },
        };
      });
    }
    else if (event.type === "agent_stream_delta" && event.caseId === cid) {
      if (get().streamingMessages[event.messageId] !== undefined) queueStreamDelta(event.messageId, event.delta);
    }
    else if (event.type === "agent_stream_end" && event.caseId === cid) {
      cancelPendingStreamDeltas(event.messageId);
      set((s) => {
        const index = s.streamingMessages[event.messageId];
        if (index === undefined) return {};
        const { [event.messageId]: _done, ...rest } = s.streamingMessages;
        const events = s.agentEvents.slice();
        if (events[index]) events[index] = { ...events[index], text: event.content };
        return {
          agentEvents: events,
          streamingMessages: rest,
          streamedAgentTexts: event.content ? [...s.streamedAgentTexts, event.content] : s.streamedAgentTexts,
        };
      });
    }
    else if (event.type === "agent_retrying" && event.caseId === cid) {
      get().addAgentEvent({ kind: "text", text: `Retrying LLM call ${event.attempt}/${event.maxAttempts}: ${event.reason}` });
    }
    else if (event.type === "agent_steering_added" && event.caseId === cid) {
      const text = `[steering] ${event.content}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "user", text });
    }
    else if (event.type === "agent_run_completed" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(null);
      get().setAgentBusy(false);
    }
    else if (event.type === "agent_run_interrupted" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(null);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "done", text: "Agent stopped" });
    }
    else if (event.type === "agent_run_needs_confirmation" && event.caseId === cid) {
      get().setPendingConfirmation({ runId: event.runId, warning: event.warning });
      get().setActiveTab("observer");
      const text = `[Observer] Critical: ${event.warning.title}`;
      get().addAgentEvent({ kind: "text", text });
      get().showToast(text);
    }
    else if (event.type === "agent_run_needs_continuation" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(event.run);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "done", text: "Agent reached the run budget. Continue to proceed." });
    }
    else if (event.type === "agent_run_failed" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(null);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "error", text: event.error });
    }
    else if (event.type === "agent_usage" && event.caseId === cid) {
      get().setTokenUsage({
        promptTokens: event.cumulativePromptTokens,
        completionTokens: event.cumulativeCompletionTokens,
        totalTokens: event.cumulativeTotalTokens,
      });
      set((state) => ({
        tokenUsageHistory: state.tokenUsageHistory.some((entry) => entry.id === event.usageId)
          ? state.tokenUsageHistory
          : [...state.tokenUsageHistory, {
            id: event.usageId,
            runId: event.runId,
            caseId: event.caseId,
            turn: event.turn,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            source: event.source,
            currency: event.currency,
            inputCostMicros: event.inputCostMicros,
            outputCostMicros: event.outputCostMicros,
            totalCostMicros: event.totalCostMicros,
            createdAt: event.createdAt,
          }],
      }));
    }
    else if (event.type === "agent_started" && event.caseId === cid) {
      get().setAgentBusy(true);
      const text = `Started: ${event.goal}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "started", text });
    }
    else if (event.type === "agent_text" && event.caseId === cid) {
      const streamedIndex = get().streamedAgentTexts.indexOf(event.content);
      if (streamedIndex !== -1) {
        set((s) => ({ streamedAgentTexts: s.streamedAgentTexts.filter((_, index) => index !== streamedIndex) }));
        return;
      }
      const last = get().agentEvents.at(-1);
      if (!(last?.kind === "text" && last.text === event.content)) get().addAgentEvent({ kind: "text", text: event.content });
    }
    else if (event.type === "agent_reasoning" && event.caseId === cid) {
      const last = get().agentEvents.at(-1);
      if (!(last?.kind === "reasoning" && last.text === event.content)) get().addAgentEvent({ kind: "reasoning", text: event.content });
    }
    else if (event.type === "agent_tool_call" && event.caseId === cid) get().addAgentEvent({ kind: "tool_call", text: `${event.tool}(${event.input})` });
    else if (event.type === "agent_tool_result" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} → ${event.content}` });
    else if (event.type === "agent_tool_blocked" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} blocked → ${event.reason}\n${event.input}` });
    else if (event.type === "agent_done" && event.caseId === cid) { get().setAgentBusy(false); get().addAgentEvent({ kind: "done", text: event.content }); }
    else if (event.type === "agent_error" && event.caseId === cid) { get().setAgentBusy(false); get().addAgentEvent({ kind: "error", text: event.content }); }
    else if (event.type === "approval_requested" && event.caseId === cid) get().setPendingApproval({ approvalId: event.approvalId, tool: event.tool, input: event.input });
    else if (event.type === "approval_resolved" && event.caseId === cid) {
      const text = `Approval ${event.decision}: ${event.tool}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "done", text });
      get().clearPendingApproval(event.approvalId);
    }
    else if (event.type === "browser_started" && event.caseId === cid) get().setBrowser("llm");
    else if (event.type === "browser_stopped" && event.caseId === cid) get().resetBrowser();
    else if (event.type === "browser_control_changed" && event.caseId === cid) get().setBrowser(event.controller);
    else if (event.type === "browser_navigated" && event.caseId === cid) get().setBrowser(get().browserController, event.url);
    else if (event.type === "observer_warning" && event.warning.caseId === cid) get().addWarning(event.warning);
    else if (event.type === "observer_warning_updated" && event.warning.caseId === cid) get().upsertWarning(event.warning);
    else if (event.type === "observer_review_completed" && event.caseId === cid) {
      set((state) => ({
        observerTelemetry: {
          reviewCount: state.observerTelemetry.reviewCount + 1,
          correctionCount: state.observerTelemetry.correctionCount + event.correctionCount,
          failureCount: state.observerTelemetry.failureCount,
          totalTokens: state.observerTelemetry.totalTokens + event.totalTokens,
          lastTrigger: event.trigger,
          lastDurationMs: event.durationMs,
        },
      }));
    }
    else if (event.type === "observer_review_failed" && event.caseId === cid) {
      set((state) => ({
        observerTelemetry: {
          ...state.observerTelemetry,
          failureCount: state.observerTelemetry.failureCount + 1,
        },
      }));
    }
    else if (event.type === "scope_expansion_proposed" && event.caseId === cid) get().setPendingScope({ host: event.host, reason: event.reason });
    else if (event.type === "scope_expansion_rejected" && event.caseId === cid) {
      const text = `Scope kept blocked: ${event.host}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "done", text });
      get().clearPendingScope(event.host);
    }
    else if (event.type === "scope_updated" && event.caseId === cid) {
      const pending = get().pendingScope;
      if (pending && event.allowHosts.includes(pending.host)) {
        const text = `Scope approved: ${pending.host}`;
        if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "done", text });
        get().clearPendingScope(pending.host);
      }
    }
    else if (event.type === "case_deleted" && event.caseId === cid) {
      get().showToast("This case has been deleted");
      get().setCase(null);
    }
  },
}));
