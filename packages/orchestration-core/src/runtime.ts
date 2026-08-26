import { evolve, ScenarioKernel } from "./kernel.js";
import type {
  CommandEnvelope,
  DurableCommandResult,
  ScenarioDefinition,
  ScenarioEvent,
  ScenarioKind,
  ScenarioRunState,
} from "./model.js";

export interface ScenarioEventStream {
  runId: string;
  revision: number;
  events: ScenarioEvent[];
}

export interface RecordedCommand {
  commandId: string;
  fingerprint: string;
  resultingRevision: number;
  events: ScenarioEvent[];
}

export interface AppendEventsRequest {
  runId: string;
  expectedRevision: number;
  commandId: string;
  fingerprint: string;
  events: ScenarioEvent[];
}

export interface AppendEventsResult {
  resultingRevision: number;
  events: ScenarioEvent[];
  idempotentReplay: boolean;
}

export interface ScenarioEventStore {
  load(runId: string): ScenarioEventStream;
  findCommand(runId: string, commandId: string): RecordedCommand | undefined;
  append(request: AppendEventsRequest): AppendEventsResult;
}

export class RevisionConflictError extends Error {
  constructor(readonly runId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Scenario run ${runId} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "RevisionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly runId: string, readonly commandId: string) {
    super(`Command ${commandId} for scenario run ${runId} was reused with different content`);
    this.name = "IdempotencyConflictError";
  }
}

export class ScenarioDefinitionRegistry {
  private readonly definitions = new Map<string, ScenarioDefinition>();

  constructor(definitions: ScenarioDefinition[]) {
    for (const definition of definitions) {
      const key = this.key(definition.kind, definition.version);
      if (this.definitions.has(key)) throw new Error(`Duplicate scenario definition ${key}`);
      this.definitions.set(key, definition);
    }
  }

  require(kind: ScenarioKind, version: number): ScenarioDefinition {
    const definition = this.definitions.get(this.key(kind, version));
    if (!definition) throw new Error(`Scenario definition ${kind}@${version} is not registered`);
    return definition;
  }

  list(): ScenarioDefinition[] {
    return [...this.definitions.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || right.version - left.version);
  }

  private key(kind: ScenarioKind, version: number): string {
    return `${kind}@${version}`;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

const systemTemporalFields = new Set(["at", "createdAt", "leaseExpiresAt"]);

export function commandFingerprint(command: unknown): string {
  const removeSystemTime = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(removeSystemTime);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !systemTemporalFields.has(key))
        .map(([key, nested]) => [key, removeSystemTime(nested)]),
    );
  };
  return canonicalJson(removeSystemTime(command));
}

export function replayScenario(events: ScenarioEvent[]): ScenarioRunState | undefined {
  let state: ScenarioRunState | undefined;
  for (const event of events) state = evolve(state, event);
  return state;
}

export class DurableScenarioRuntime {
  constructor(
    private readonly store: ScenarioEventStore,
    private readonly definitions: ScenarioDefinitionRegistry,
  ) {}

  load(runId: string): ScenarioRunState | undefined {
    return replayScenario(this.store.load(runId).events);
  }

  execute(envelope: CommandEnvelope): DurableCommandResult {
    if (!envelope.commandId.trim()) throw new Error("Command id is required");
    if (envelope.command.type === "start_run" && envelope.command.runId !== envelope.runId) {
      throw new Error(`Start command run id ${envelope.command.runId} does not match envelope ${envelope.runId}`);
    }

    const fingerprint = commandFingerprint(envelope.command);
    const recorded = this.store.findCommand(envelope.runId, envelope.commandId);
    if (recorded) return this.replayRecorded(envelope.runId, recorded, fingerprint);

    const stream = this.store.load(envelope.runId);
    if (stream.revision !== envelope.expectedRevision) {
      throw new RevisionConflictError(envelope.runId, envelope.expectedRevision, stream.revision);
    }
    const current = replayScenario(stream.events);
    const definition = current
      ? this.definitions.require(current.definitionKind, current.definitionVersion)
      : this.requireDefinitionForStart(envelope);
    const decision = new ScenarioKernel(definition).execute(current, envelope.command);
    const appended = this.store.append({
      runId: envelope.runId,
      expectedRevision: envelope.expectedRevision,
      commandId: envelope.commandId,
      fingerprint,
      events: decision.events,
    });
    if (appended.idempotentReplay) {
      const raced = this.store.findCommand(envelope.runId, envelope.commandId);
      if (!raced) throw new Error(`Idempotent command ${envelope.commandId} disappeared after append`);
      return this.replayRecorded(envelope.runId, raced, fingerprint);
    }
    const state = this.load(envelope.runId);
    if (!state) throw new Error(`Scenario run ${envelope.runId} has no state after command ${envelope.commandId}`);
    return { state, events: appended.events, idempotentReplay: false };
  }

  private requireDefinitionForStart(envelope: CommandEnvelope): ScenarioDefinition {
    if (envelope.command.type !== "start_run") throw new Error(`Scenario run ${envelope.runId} has not started`);
    if (!envelope.definitionKind || envelope.definitionVersion === undefined) {
      throw new Error("Starting a scenario requires definition kind and version");
    }
    return this.definitions.require(envelope.definitionKind, envelope.definitionVersion);
  }

  private replayRecorded(runId: string, recorded: RecordedCommand, fingerprint: string): DurableCommandResult {
    if (recorded.fingerprint !== fingerprint) throw new IdempotencyConflictError(runId, recorded.commandId);
    const state = this.load(runId);
    if (!state) throw new Error(`Recorded command ${recorded.commandId} has no scenario state`);
    return { state, events: recorded.events, idempotentReplay: true };
  }
}
