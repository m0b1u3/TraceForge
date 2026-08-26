import { create } from "zustand";
import type { Case, RuntimeEvent } from "@traceforge/shared";
import { createAgentProtocolProjection, mergeAgentProtocolEvents, type AgentProtocolProjection } from "./agent-runtime-projection.js";
import {
  deleteCase as deleteCaseApi,
  cancelScenarioRun as cancelScenarioRunApi,
  createScenarioAuthorization as createScenarioAuthorizationApi,
  createScenarioRun as createScenarioRunApi,
  getScenarioRun,
  getScenarioCollaboration,
  getScenarioRunRecovery,
  getLlmConfig,
  getScenarioAgentEvents,
  listScenarioApprovals,
  listScenarioAuthorizations,
  listScenarioDefinitions,
  listCases,
  listScenarioRuns,
  pauseScenarioRun as pauseScenarioRunApi,
  resumeScenarioRun as resumeScenarioRunApi,
  resolveScenarioApproval as resolveScenarioApprovalApi,
  revokeScenarioAuthorization as revokeScenarioAuthorizationApi,
  testLlmConfig,
  updateLlmConfig,
  type LlmConfig,
  type LlmConfigInput,
  type ScenarioApproval,
  type ScenarioAuthorization,
  type ScenarioCollaborationSnapshot,
  type ScenarioDefinitionView,
  type ScenarioRunSummary,
  type ScenarioRunState,
  type ScenarioRunRecoveryDiagnostic,
} from "./api.js";

export type AgentProtocolSyncStatus = "stale" | "recovering" | "live";
export type ConnectionStatus = "online" | "reconnecting" | "offline";
export type ScenarioOperationsStatus = "idle" | "loading" | "ready" | "error";
export type ToastTone = "info" | "success" | "error";
export interface ToastNotice { id: number; message: string; tone: ToastTone }

export function runtimeWebSocketUrl(locationValue: Pick<Location, "protocol" | "host">): string {
  return `${locationValue.protocol === "https:" ? "wss:" : "ws:"}//${locationValue.host}/ws`;
}

interface State {
  caseId: string | null;
  cases: Case[];
  agentProtocol: AgentProtocolProjection | null;
  agentProtocolSyncStatus: AgentProtocolSyncStatus;
  connectionStatus: ConnectionStatus;
  toast: ToastNotice | null;
  settingsModalOpen: boolean;
  llmConfig: LlmConfig | null;
  scenarioDefinitions: ScenarioDefinitionView[];
  scenarioAuthorizations: ScenarioAuthorization[];
  scenarioRuns: ScenarioRunSummary[];
  activeScenarioRun: ScenarioRunState | null;
  scenarioApprovals: ScenarioApproval[];
  scenarioCollaboration: ScenarioCollaborationSnapshot | null;
  scenarioRecovery: ScenarioRunRecoveryDiagnostic | null;
  scenarioOperationsStatus: ScenarioOperationsStatus;
  setCases: (cases: Case[]) => void;
  enterCase: (caseId: string) => Promise<void>;
  leaveCase: () => void;
  deleteCase: (caseId: string) => Promise<void>;
  showToast: (message: string, tone?: ToastTone) => void;
  setSettingsModalOpen: (open: boolean) => void;
  loadLlmConfig: () => Promise<void>;
  saveLlmConfig: (input: LlmConfigInput) => Promise<void>;
  testLlmConfig: (input: LlmConfigInput) => Promise<{ ok: boolean; message?: string; error?: string }>;
  refreshScenarioOperations: () => Promise<void>;
  refreshScenarioCollaboration: () => Promise<void>;
  createScenarioAuthorization: (input: Omit<Parameters<typeof createScenarioAuthorizationApi>[0], "caseId" | "scenarioKind">) => Promise<void>;
  revokeScenarioAuthorization: (authorizationId: string) => Promise<void>;
  startScenarioRun: (goal: string, authorizationId: string, definitionVersion: number) => Promise<void>;
  cancelScenarioRun: (reason: string) => Promise<void>;
  pauseScenarioRun: (reason: string) => Promise<void>;
  resumeScenarioRun: (reason: string) => Promise<void>;
  resolveScenarioApproval: (approvalId: string, approved: boolean, reason: string) => Promise<void>;
  syncAgentProtocol: (runId: string, reset?: boolean) => Promise<void>;
  refreshAgentProtocol: () => Promise<void>;
  handleRuntimeEvent: (event: RuntimeEvent) => void;
  connectWs: () => () => void;
}

let toastSequence = 0;
let disconnectActiveWebSocket: (() => void) | null = null;
const protocolSyncs = new Map<string, Promise<void>>();

export const useStore = create<State>((set, get) => ({
  caseId: null,
  cases: [],
  agentProtocol: null,
  agentProtocolSyncStatus: "stale",
  connectionStatus: "offline",
  toast: null,
  settingsModalOpen: false,
  llmConfig: null,
  scenarioDefinitions: [],
  scenarioAuthorizations: [],
  scenarioRuns: [],
  activeScenarioRun: null,
  scenarioApprovals: [],
  scenarioCollaboration: null,
  scenarioRecovery: null,
  scenarioOperationsStatus: "idle",
  setCases: (cases) => set({ cases }),
  enterCase: async (caseId) => {
    set({
      caseId, agentProtocol: null, agentProtocolSyncStatus: "recovering",
      scenarioAuthorizations: [], scenarioRuns: [], activeScenarioRun: null, scenarioApprovals: [], scenarioCollaboration: null, scenarioRecovery: null, scenarioOperationsStatus: "loading",
    });
    await Promise.all([get().refreshAgentProtocol(), get().refreshScenarioOperations()]);
  },
  leaveCase: () => set({
    caseId: null, agentProtocol: null, agentProtocolSyncStatus: "stale",
    scenarioAuthorizations: [], scenarioRuns: [], activeScenarioRun: null, scenarioApprovals: [], scenarioCollaboration: null, scenarioRecovery: null, scenarioOperationsStatus: "idle",
  }),
  deleteCase: async (caseId) => {
    await deleteCaseApi(caseId);
    set((state) => ({
      cases: state.cases.filter((entry) => entry.id !== caseId),
      ...(state.caseId === caseId ? {
        caseId: null, agentProtocol: null, agentProtocolSyncStatus: "stale" as const,
        scenarioAuthorizations: [], scenarioRuns: [], activeScenarioRun: null, scenarioApprovals: [], scenarioCollaboration: null, scenarioRecovery: null, scenarioOperationsStatus: "idle" as const,
      } : {}),
    }));
  },
  showToast: (message, tone = "info") => {
    const notice = { id: ++toastSequence, message, tone };
    set({ toast: notice });
    setTimeout(() => { if (get().toast?.id === notice.id) set({ toast: null }); }, tone === "error" ? 6_000 : 4_000);
  },
  setSettingsModalOpen: (settingsModalOpen) => set({ settingsModalOpen }),
  loadLlmConfig: async () => set({ llmConfig: await getLlmConfig() }),
  saveLlmConfig: async (input) => set({ llmConfig: await updateLlmConfig(input) }),
  testLlmConfig,
  refreshScenarioOperations: async () => {
    const caseId = get().caseId;
    if (!caseId) return;
    set({ scenarioOperationsStatus: "loading" });
    try {
      const [definitions, authorizations, runs, approvals] = await Promise.all([
        listScenarioDefinitions(),
        listScenarioAuthorizations(caseId),
        listScenarioRuns(caseId),
        listScenarioApprovals(caseId, "pending"),
      ]);
      const selected = runs.find((run) => run.status === "running") ?? runs.find((run) => run.status === "paused") ?? runs[0];
      const activeScenarioRun = selected ? await getScenarioRun(selected.runId) : null;
      const scenarioCollaboration = selected ? await getScenarioCollaboration(selected.runId) : null;
      const scenarioRecovery = selected ? await getScenarioRunRecovery(selected.runId) : null;
      if (get().caseId !== caseId) return;
      set({
        scenarioDefinitions: definitions,
        scenarioAuthorizations: authorizations,
        scenarioRuns: runs,
        activeScenarioRun,
        scenarioApprovals: approvals,
        scenarioCollaboration,
        scenarioRecovery,
        scenarioOperationsStatus: "ready",
      });
    } catch (error) {
      if (get().caseId === caseId) set({ scenarioOperationsStatus: "error" });
      throw error;
    }
  },
  refreshScenarioCollaboration: async () => {
    const selected = get().activeScenarioRun;
    const caseId = get().caseId;
    if (!selected || !caseId) return;
    const [activeScenarioRun, scenarioCollaboration, scenarioRecovery] = await Promise.all([
      getScenarioRun(selected.id),
      getScenarioCollaboration(selected.id),
      getScenarioRunRecovery(selected.id),
    ]);
    if (get().caseId !== caseId || get().activeScenarioRun?.id !== selected.id) return;
    set({ activeScenarioRun, scenarioCollaboration, scenarioRecovery });
  },
  createScenarioAuthorization: async (input) => {
    const caseId = get().caseId;
    if (!caseId) throw new Error("No active Case");
    const authorization = await createScenarioAuthorizationApi({ ...input, caseId, scenarioKind: "web_blackbox" });
    set((state) => ({
      scenarioAuthorizations: [authorization, ...state.scenarioAuthorizations.filter((entry) => entry.id !== authorization.id)],
    }));
    await get().refreshScenarioOperations().catch(() => undefined);
  },
  revokeScenarioAuthorization: async (authorizationId) => {
    await revokeScenarioAuthorizationApi(authorizationId);
    set((state) => ({
      scenarioAuthorizations: state.scenarioAuthorizations.map((entry) => (
        entry.id === authorizationId ? { ...entry, status: "revoked" as const } : entry
      )),
    }));
    await get().refreshScenarioOperations().catch(() => undefined);
    await get().refreshAgentProtocol();
  },
  startScenarioRun: async (goal, authorizationId, definitionVersion) => {
    const caseId = get().caseId;
    if (!caseId) throw new Error("No active Case");
    const result = await createScenarioRunApi({
      caseId, goal, scopeRef: authorizationId, scenarioKind: "web_blackbox", definitionVersion,
    });
    set({ activeScenarioRun: result.state });
    await Promise.all([
      get().refreshScenarioOperations().catch(() => undefined),
      get().syncAgentProtocol(result.state.id, true),
    ]);
  },
  cancelScenarioRun: async (reason) => {
    const selected = get().activeScenarioRun;
    if (!selected) throw new Error("No Scenario Run selected");
    const current = await getScenarioRun(selected.id);
    const result = await cancelScenarioRunApi(current.id, current.revision, reason);
    set({ activeScenarioRun: result.state });
    await Promise.all([
      get().refreshScenarioOperations().catch(() => undefined),
      get().refreshAgentProtocol(),
    ]);
  },
  pauseScenarioRun: async (reason) => {
    const selected = get().activeScenarioRun;
    if (!selected) throw new Error("No Scenario Run selected");
    const current = await getScenarioRun(selected.id);
    const result = await pauseScenarioRunApi(current.id, current.revision, reason);
    set({ activeScenarioRun: result.state });
    await Promise.all([
      get().refreshScenarioOperations().catch(() => undefined),
      get().refreshAgentProtocol(),
    ]);
  },
  resumeScenarioRun: async (reason) => {
    const selected = get().activeScenarioRun;
    if (!selected) throw new Error("No Scenario Run selected");
    const current = await getScenarioRun(selected.id);
    const result = await resumeScenarioRunApi(current.id, current.revision, reason);
    set({ activeScenarioRun: result.state });
    await Promise.all([
      get().refreshScenarioOperations().catch(() => undefined),
      get().refreshAgentProtocol(),
    ]);
  },
  resolveScenarioApproval: async (approvalId, approved, reason) => {
    const approval = get().scenarioApprovals.find((candidate) => candidate.id === approvalId);
    if (!approval) throw new Error(`Unknown pending approval ${approvalId}`);
    const current = await getScenarioRun(approval.runId);
    const result = await resolveScenarioApprovalApi(approvalId, current.revision, approved, reason);
    set((state) => ({
      activeScenarioRun: state.activeScenarioRun?.id === result.state.id ? result.state : state.activeScenarioRun,
      scenarioApprovals: state.scenarioApprovals.filter((entry) => entry.id !== approvalId),
    }));
    await Promise.all([
      get().refreshScenarioOperations().catch(() => undefined),
      get().refreshAgentProtocol(),
    ]);
  },
  syncAgentProtocol: async (runId, reset = false) => {
    if (reset || get().agentProtocol?.runId !== runId) {
      set({ agentProtocol: createAgentProtocolProjection(runId), agentProtocolSyncStatus: "recovering" });
    }
    const existing = protocolSyncs.get(runId);
    if (existing) return existing;
    let task!: Promise<void>;
    task = (async () => {
      set({ agentProtocolSyncStatus: "recovering" });
      for (;;) {
        const current = get().agentProtocol;
        if (!current || current.runId !== runId) return;
        const page = await getScenarioAgentEvents(runId, current.cursor);
        const latest = get().agentProtocol;
        if (!latest || latest.runId !== runId) return;
        const merged = mergeAgentProtocolEvents(latest, page.events);
        set({ agentProtocol: merged });
        if (page.hasMore) continue;
        if (Object.keys(merged.pending).length && merged.cursor > current.cursor) continue;
        set({ agentProtocolSyncStatus: Object.keys(merged.pending).length ? "recovering" : "live" });
        return;
      }
    })().catch(() => {
      if (get().agentProtocol?.runId === runId) set({ agentProtocolSyncStatus: "stale" });
    }).finally(() => {
      if (protocolSyncs.get(runId) === task) protocolSyncs.delete(runId);
    });
    protocolSyncs.set(runId, task);
    return task;
  },
  refreshAgentProtocol: async () => {
    const caseId = get().caseId;
    if (!caseId) return;
    try {
      const latest = (await listScenarioRuns(caseId))[0];
      if (get().caseId !== caseId) return;
      if (!latest) return set({ agentProtocol: null, agentProtocolSyncStatus: "live" });
      await get().syncAgentProtocol(latest.runId, get().agentProtocol?.runId !== latest.runId);
    } catch {
      if (get().caseId === caseId) set({ agentProtocolSyncStatus: "stale" });
    }
  },
  handleRuntimeEvent: (event) => {
    const caseId = get().caseId;
    if (event.type === "scenario_agent_event" && event.event.caseId === caseId) {
      const incoming = event.event;
      const startsRun = incoming.method === "item/completed"
        && incoming.params.item.type === "controlChange"
        && incoming.params.item.eventType === "run_started";
      const current = get().agentProtocol;
      if (!current || (startsRun && current.runId !== incoming.runId)) {
        const next = mergeAgentProtocolEvents(createAgentProtocolProjection(incoming.runId), [incoming]);
        set({ agentProtocol: next, agentProtocolSyncStatus: next.cursor === incoming.sequence ? "live" : "recovering" });
        if (next.cursor < incoming.sequence) void get().syncAgentProtocol(incoming.runId);
      } else if (current.runId === incoming.runId) {
        const next = mergeAgentProtocolEvents(current, [incoming]);
        set({ agentProtocol: next });
        if (next.cursor < incoming.sequence) void get().syncAgentProtocol(incoming.runId);
      }
      const item = incoming.method === "item/started" || incoming.method === "item/updated" || incoming.method === "item/completed"
        ? incoming.params.item
        : null;
      if (item?.type === "approval" || item?.type === "controlChange") {
        void get().refreshScenarioOperations().catch(() => undefined);
      } else if ((incoming.role === "planner" || incoming.role === "observer") && incoming.method === "turn/completed") {
        void get().refreshScenarioCollaboration().catch(() => undefined);
      }
    } else if (event.type === "case_created") {
      set((state) => ({ cases: state.cases.some((entry) => entry.id === event.case.id) ? state.cases : [...state.cases, event.case] }));
    } else if (event.type === "case_deleted" && event.caseId === caseId) {
      get().leaveCase();
    }
  },
  connectWs: () => {
    disconnectActiveWebSocket?.();
    let disposed = false;
    let retry = 0;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disconnect = () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      socket = null;
      set({ connectionStatus: "offline", agentProtocolSyncStatus: "stale" });
      if (disconnectActiveWebSocket === disconnect) disconnectActiveWebSocket = null;
    };
    const open = () => {
      if (disposed) return;
      const ws = new WebSocket(runtimeWebSocketUrl(location));
      socket = ws;
      ws.onopen = () => { retry = 0; set({ connectionStatus: "online" }); void get().refreshAgentProtocol(); };
      ws.onmessage = (message) => get().handleRuntimeEvent(JSON.parse(message.data) as RuntimeEvent);
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        set({ connectionStatus: "reconnecting", agentProtocolSyncStatus: "recovering" });
        timer = setTimeout(open, Math.min(1_000 * 2 ** retry++, 10_000));
      };
    };
    disconnectActiveWebSocket = disconnect;
    open();
    return disconnect;
  },
}));

export async function loadCasesIntoStore(): Promise<void> {
  useStore.getState().setCases(await listCases());
}
