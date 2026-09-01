import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkerCheckpointDocument, WorkerCheckpointStore } from "./model.js";

export const maximumCheckpointBytes = 1024 * 1024;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function requireJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error("Checkpoint input nesting exceeds its limit");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const entry of value) requireJson(entry, depth + 1); return; }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const entry of Object.values(value)) requireJson(entry, depth + 1);
    return;
  }
  throw new Error("Checkpoint invocation input must be losslessly JSON serializable");
}

/** Validate at both disk and runtime boundaries, including custom stores. */
export function validateWorkerCheckpoint(value: unknown): WorkerCheckpointDocument {
  if (!value || typeof value !== "object") throw new Error("Invalid checkpoint document");
  const d = value as WorkerCheckpointDocument;
  if (![1, 2].includes(d.version) || ![d.workerId, d.runId, d.workId, d.leaseId, d.savedAt].every(isString)
    || !Number.isFinite(Date.parse(d.savedAt)) || !Number.isSafeInteger(d.turn) || d.turn < 0
    || !strings(d.completedInvocationIds) || new Set(d.completedInvocationIds).size !== d.completedInvocationIds.length
    || !Array.isArray(d.steering) || !d.steering.every((v) => typeof v === "string")
    || !Array.isArray(d.transcript) || !d.transcript.every((e) => e && Number.isSafeInteger(e.turn) && e.turn >= 0
      && ["model", "tool", "observer", "system"].includes(e.kind) && typeof e.summary === "string" && Array.isArray(e.refs) && e.refs.every(isString)
      && (e.receiptKey === undefined || (e.kind === "tool" && isString(e.receiptKey))))) {
    throw new Error("Invalid checkpoint document");
  }
  if (d.version === 2) {
    if (!isString(d.caseId) || !isString(d.workKey) || !Number.isSafeInteger(d.consecutiveFailures) || d.consecutiveFailures! < 0
      || d.pendingInvocation === undefined) throw new Error("Invalid v2 checkpoint identity or recovery state");
    const p = d.pendingInvocation;
    if (p && (p.turn !== d.turn + 1 || !p.invocation || ![p.invocation.id, p.invocation.tool].every(isString)
      || typeof p.invocation.rationale !== "string" || !("input" in p.invocation)
      || !["read_only", "bounded_write", "privileged", "destructive"].includes(p.risk)
      || !/^[a-f0-9]{64}$/.test(p.contractFingerprint) || d.completedInvocationIds.includes(p.invocation.id))) {
      throw new Error("Invalid pending checkpoint invocation");
    }
    if (p) requireJson(p.invocation.input);
  } else if (d.pendingInvocation) throw new Error("Legacy checkpoints cannot carry pending invocations");
  if (Buffer.byteLength(JSON.stringify(d), "utf8") > maximumCheckpointBytes) throw new Error("Checkpoint exceeds its size limit");
  return d;
}

export class JsonFileCheckpointStore implements WorkerCheckpointStore {
  constructor(private readonly root: string, private readonly legacyRoot: string = root) {}

  async save(document: WorkerCheckpointDocument): Promise<string> {
    validateWorkerCheckpoint(document);
    const body = JSON.stringify(document);
    const name = `sha256-${digest(body)}.json`;
    await mkdir(this.root, { recursive: true });
    const target = resolve(this.root, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
      if (process.platform !== "win32") {
        const directory = await open(this.root, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    return `checkpoint://${name}`;
  }

  async load(ref: string): Promise<WorkerCheckpointDocument> {
    const name = ref.startsWith("checkpoint://") ? ref.slice("checkpoint://".length) : "";
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*\.json$/.test(name)) throw new Error("Unsafe checkpoint reference");
    const hashed = /^sha256-([a-f0-9]{64})\.json$/.exec(name);
    const file = await open(resolve(hashed ? this.root : this.legacyRoot, name), "r");
    let body: string;
    try {
      if ((await file.stat()).size > maximumCheckpointBytes) throw new Error("Checkpoint exceeds its size limit");
      body = await file.readFile("utf8");
    } finally { await file.close(); }
    if (hashed && digest(body) !== hashed[1]) throw new Error("Checkpoint integrity mismatch");
    const document = validateWorkerCheckpoint(JSON.parse(body));
    if (!hashed && document.version !== 1) throw new Error("V2 checkpoint requires an immutable digest reference");
    return document;
  }
}
