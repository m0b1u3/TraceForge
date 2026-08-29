import { describe, expect, it } from "vitest";
import {
  ToolProviderFairScheduler,
  ToolProviderSchedulingError,
  type ToolProviderSchedulingAuditRecord,
  type ToolProviderSchedulingIdentity,
} from "./tool-provider-scheduler.js";

function identity(runId: string, workId: string, toolName = "neutral.inspect"): ToolProviderSchedulingIdentity {
  return {
    providerId: "provider.neutral",
    providerVersion: "1.0.0",
    toolName,
    caseId: `case-${runId}`,
    runId,
    workId,
  };
}

describe("ToolProviderFairScheduler", () => {
  it("admits another Run when the current Run is at its quota", async () => {
    const scheduler = new ToolProviderFairScheduler({ global: 2, perProvider: 2, perTool: 2, perRun: 1, perWork: 1 });
    const first = await scheduler.acquire(identity("first", "one"));
    let sameRunAdmitted = false;
    const sameRun = scheduler.acquire(identity("first", "two")).then((lease) => {
      sameRunAdmitted = true;
      return lease;
    });
    const otherRun = await scheduler.acquire(identity("second", "one"));

    expect(sameRunAdmitted).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 1 });
    otherRun.release();
    expect(sameRunAdmitted).toBe(false);
    first.release();
    const admitted = await sameRun;
    expect(sameRunAdmitted).toBe(true);
    admitted.release();
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("enforces Provider, tool and Work quotas and releases leases idempotently", async () => {
    const scheduler = new ToolProviderFairScheduler({ global: 5, perProvider: 2, perTool: 1, perRun: 5, perWork: 1 });
    const first = await scheduler.acquire(identity("first", "one", "neutral.first"));
    const otherTool = await scheduler.acquire(identity("second", "one", "neutral.second"));
    let thirdAdmitted = false;
    const third = scheduler.acquire(identity("third", "one", "neutral.third")).then((lease) => {
      thirdAdmitted = true;
      return lease;
    });
    expect(thirdAdmitted).toBe(false);
    first.release();
    first.release();
    const admitted = await third;
    expect(thirdAdmitted).toBe(true);
    otherTool.release();
    admitted.release();

    const work = await scheduler.acquire(identity("fourth", "same", "neutral.first"));
    let duplicateWorkAdmitted = false;
    const duplicate = scheduler.acquire(identity("fourth", "same", "neutral.second")).then((lease) => {
      duplicateWorkAdmitted = true;
      return lease;
    });
    expect(duplicateWorkAdmitted).toBe(false);
    work.release();
    const duplicateLease = await duplicate;
    duplicateLease.release();
  });

  it("bounds the queue and writes structured rejection audit without blocking scheduling", async () => {
    const audit: ToolProviderSchedulingAuditRecord[] = [];
    const scheduler = new ToolProviderFairScheduler(
      { global: 1, perProvider: 1, perTool: 1, perRun: 1, perWork: 1, maximumQueued: 1 },
      { write(record) { audit.push(record); } },
    );
    const active = await scheduler.acquire(identity("first", "one"));
    const queued = scheduler.acquire(identity("second", "one"));
    await expect(scheduler.acquire(identity("third", "one"))).rejects.toMatchObject({
      name: "ToolProviderSchedulingError",
      reason: "queue_full",
      retryable: true,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "rejected", reason: "queue_full", identity: { runId: "third", workId: "one" } });
    active.release();
    (await queued).release();
  });

  it("removes timed out and cancelled waiters without consuming capacity", async () => {
    const audit: ToolProviderSchedulingAuditRecord[] = [];
    const scheduler = new ToolProviderFairScheduler(
      { global: 1, perProvider: 1, perTool: 1, perRun: 1, perWork: 1, maximumWaitMs: 20 },
      { write(record) { audit.push(record); } },
    );
    const active = await scheduler.acquire(identity("first", "one"));
    await expect(scheduler.acquire(identity("second", "one"))).rejects.toEqual(expect.objectContaining({ reason: "wait_timeout" }));

    const cancellation = new AbortController();
    const cancelled = scheduler.acquire(identity("third", "one"), cancellation.signal);
    cancellation.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ToolProviderSchedulingError);
    expect(audit.map((record) => record.reason)).toEqual(["wait_timeout", "cancelled"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 0 });
    active.release();
  });
});
