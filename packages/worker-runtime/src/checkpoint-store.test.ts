import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileCheckpointStore, maximumCheckpointBytes, validateWorkerCheckpoint } from "./checkpoint-store.js";
import type { WorkerCheckpointDocument } from "./model.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function document(): WorkerCheckpointDocument {
  return { version: 2, workerId: "worker", runId: "run", workId: "work", caseId: "case", workKey: "effect",
    leaseId: "lease", turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0,
    savedAt: "2026-08-30T00:00:00.000Z", pendingInvocation: { turn: 1,
      invocation: { id: "first", tool: "observe", input: { value: "original" }, rationale: "Observe" },
      risk: "read_only", contractFingerprint: "a".repeat(64) } };
}
async function setup() { const root = await mkdtemp(join(tmpdir(), "traceforge-checkpoint-")); roots.push(root); return { root, store: new JsonFileCheckpointStore(root) }; }

describe("Immutable Worker checkpoints", () => {
  it("preserves host receipt provenance and rejects malformed or non-tool provenance", () => {
    const entry = { turn: 1, kind: "tool", summary: "observed", refs: [], receiptKey: "effect:first" };
    expect(validateWorkerCheckpoint({ ...document(), transcript: [entry] }).transcript[0]!.receiptKey).toBe("effect:first");
    expect(() => validateWorkerCheckpoint({ ...document(), transcript: [{ ...entry, receiptKey: 1 }] })).toThrow();
    expect(() => validateWorkerCheckpoint({ ...document(), transcript: [{ ...entry, kind: "model" }] })).toThrow();
  });
  it("keeps the committed reference readable after an uncommitted save and a fresh store", async () => {
    const { root, store } = await setup(); const before = document();
    const ref = await store.save(before);
    const next = { ...before, turn: 1, pendingInvocation: null, completedInvocationIds: ["first"] };
    const nextRef = await store.save(next);
    expect(nextRef).not.toBe(ref);
    expect(await new JsonFileCheckpointStore(root).load(ref)).toEqual(before);
    expect(await store.load(nextRef)).toEqual(next);
    expect(await store.save(before)).toBe(ref);
  });
  it("supports concurrent saves without overwriting another snapshot", async () => {
    const { store } = await setup();
    const refs = await Promise.all(Array.from({ length: 12 }, (_, i) => store.save({ ...document(), steering: [`instruction ${i}`] })));
    expect(new Set(refs).size).toBe(12);
    for (let i = 0; i < refs.length; i++) expect((await store.load(refs[i]!)).steering).toEqual([`instruction ${i}`]);
  });
  it("rejects content tampering instead of trusting the path", async () => {
    const { root, store } = await setup(); const ref = await store.save(document());
    const path = join(root, ref.slice("checkpoint://".length));
    await writeFile(path, (await readFile(path, "utf8")).replace("original", "modified"));
    await expect(store.load(ref)).rejects.toThrow("integrity mismatch");
  });
  it.each(["checkpoint://../outside.json", "checkpoint:///outside.json", "other://first.json", "checkpoint://.."])("rejects unsafe ref %s", async (ref) => {
    const { store } = await setup(); await expect(store.load(ref)).rejects.toThrow("Unsafe");
  });
  it("bounds disk reads and refuses oversized documents before saving", async () => {
    const { root, store } = await setup();
    await writeFile(join(root, "legacy.json"), " ".repeat(maximumCheckpointBytes + 1));
    await expect(store.load("checkpoint://legacy.json")).rejects.toThrow("size limit");
    await expect(store.save({ ...document(), steering: ["x".repeat(maximumCheckpointBytes)] })).rejects.toThrow("size limit");
  });
  it.each([undefined, NaN, { value: undefined }, new Date(), Array(2), { nested: Infinity }])("rejects lossy invocation input %#", (input) => {
    const d = document(); d.pendingInvocation!.invocation.input = input;
    expect(() => validateWorkerCheckpoint(d)).toThrow("JSON serializable");
  });
  it("rejects pending/completed overlap and incorrect pending turn", () => {
    expect(() => validateWorkerCheckpoint({ ...document(), completedInvocationIds: ["first"] })).toThrow("pending");
    expect(() => validateWorkerCheckpoint({ ...document(), turn: 4 })).toThrow("pending");
  });
  it("reads old v1 snapshots only through the legacy directory", async () => {
    const { root, store } = await setup();
    const legacy = { ...document(), version: 1, pendingInvocation: undefined };
    await writeFile(join(root, "legacy.json"), JSON.stringify(legacy));
    expect((await store.load("checkpoint://legacy.json")).version).toBe(1);
    await writeFile(join(root, "legacy.json"), JSON.stringify(document()));
    await expect(store.load("checkpoint://legacy.json")).rejects.toThrow("immutable digest");
  });
});
