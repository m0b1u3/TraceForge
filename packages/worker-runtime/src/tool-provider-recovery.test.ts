import { describe, expect, it } from "vitest";
import {
  ToolProviderRecoverySupervisor,
  classifyToolProviderFailure,
  type ToolProviderRecoveryIdentity,
  type ToolProviderRecoverySnapshot,
  type ToolProviderRecoveryStatePort,
} from "./tool-provider-recovery.js";
import { ToolProviderSchedulingError } from "./tool-provider-scheduler.js";

class MemoryState implements ToolProviderRecoveryStatePort {
  value: ToolProviderRecoverySnapshot | undefined;
  async load(_identity: ToolProviderRecoveryIdentity) { return this.value ? structuredClone(this.value) : undefined; }
  async save(snapshot: ToolProviderRecoverySnapshot) { this.value = structuredClone(snapshot); }
}

function harness(state = new MemoryState()) {
  let current = new Date("2026-08-28T12:00:00.000Z");
  return {
    state,
    setNow(value: string) { current = new Date(value); },
    advance(milliseconds: number) { current = new Date(current.getTime() + milliseconds); },
    open: () => ToolProviderRecoverySupervisor.open({
      identity: { providerId: "provider.fixture", version: "1.0.0" },
      state,
      baseDelayMs: 1_000,
      maximumDelayMs: 8_000,
      failureBudget: 3,
      failureWindowMs: 60_000,
      stabilityWindowMs: 10_000,
      jitterRatio: 0,
      now: () => current,
      random: () => 0.5,
    }),
  };
}

describe("ToolProviderRecoverySupervisor", () => {
  it("classifies generic failure families without tool or Scenario semantics", () => {
    expect(classifyToolProviderFailure(new Error("process exited with code 9"))).toMatchObject({ kind: "crash", retryable: true });
    expect(classifyToolProviderFailure(Object.assign(new Error("adapter disconnected"), { retryable: true }))).toMatchObject({ kind: "transport", retryable: true });
    expect(classifyToolProviderFailure(new Error("protocol handshake is incompatible"))).toMatchObject({ kind: "protocol", retryable: false });
    expect(classifyToolProviderFailure(new Error("sandbox attestation mismatch"))).toMatchObject({ kind: "policy", retryable: false });
    expect(classifyToolProviderFailure(new Error("memory resource quota exceeded"))).toMatchObject({ kind: "resource", retryable: true });
  });

  it("uses exponential backoff and refuses early recovery attempts", async () => {
    const test = harness();
    const supervisor = await test.open();
    await supervisor.recordFailure(new Error("provider disconnected"));
    expect(supervisor.snapshot()).toMatchObject({ status: "backoff", nextAttemptAt: "2026-08-28T12:00:01.000Z" });
    let attempts = 0;
    expect(await supervisor.runRecovery(async () => { attempts += 1; })).toMatchObject({ attempted: false });
    test.advance(1_000);
    expect(await supervisor.runRecovery(async () => { attempts += 1; throw new Error("process exited with code 9"); })).toMatchObject({
      attempted: true,
      recovered: false,
      snapshot: { status: "backoff", nextAttemptAt: "2026-08-28T12:00:03.000Z" },
    });
    expect(attempts).toBe(1);
  });

  it("does not charge scheduling cancellation to the Provider failure budget", async () => {
    const test = harness();
    const supervisor = await test.open();
    await supervisor.recordFailure(new Error("provider disconnected"));
    test.advance(1_000);
    const before = supervisor.snapshot();
    await expect(supervisor.runRecovery(async () => {
      throw new ToolProviderSchedulingError("cancelled");
    })).rejects.toMatchObject({ reason: "cancelled", countsTowardProviderRecovery: false });
    expect(supervisor.snapshot()).toMatchObject({
      status: before.status,
      failures: before.failures,
      nextAttemptAt: before.nextAttemptAt,
      revision: before.revision + 2,
    });
  });

  it("quarantines after the bounded failure budget and stops a restart storm", async () => {
    const test = harness();
    const supervisor = await test.open();
    for (let count = 0; count < 3; count += 1) {
      await supervisor.recordFailure(new Error("provider process crashed"));
      test.advance(8_000);
    }
    expect(supervisor.snapshot()).toMatchObject({
      status: "quarantined",
      quarantineReason: expect.stringContaining("Failure budget 3 exhausted"),
    });
    const quarantined = supervisor.snapshot();
    await supervisor.recordFailure(new Error("another provider crash"));
    expect(supervisor.snapshot()).toEqual(quarantined);
    let attempts = 0;
    for (let count = 0; count < 20; count += 1) {
      test.advance(60_000);
      await supervisor.runRecovery(async () => { attempts += 1; });
    }
    expect(attempts).toBe(0);
  });

  it("immediately quarantines non-retryable protocol and policy failures", async () => {
    for (const message of ["protocol handshake is incompatible", "sandbox permission attestation mismatch"]) {
      const supervisor = await harness().open();
      await supervisor.recordFailure(new Error(message));
      expect(supervisor.snapshot()).toMatchObject({ status: "quarantined", quarantineReason: expect.stringContaining("explicit operator recovery") });
    }
  });

  it("coalesces a due recovery and requires a stable observation window before resetting failures", async () => {
    const test = harness();
    const supervisor = await test.open();
    await supervisor.recordFailure(new Error("provider disconnected"));
    test.advance(1_000);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const first = supervisor.runRecovery(async () => { attempts += 1; await blocked; });
    const second = supervisor.runRecovery(async () => { attempts += 1; });
    release();
    expect(await first).toMatchObject({ attempted: true, recovered: true, snapshot: { status: "observing" } });
    expect(await second).toMatchObject({ attempted: true, recovered: true, coalesced: true });
    expect(attempts).toBe(1);
    expect((await supervisor.observeHealthy()).status).toBe("observing");
    test.advance(10_000);
    expect(await supervisor.observeHealthy()).toMatchObject({ status: "healthy", failures: [] });
  });

  it("restores durable state and converts an interrupted recovery into backoff", async () => {
    const test = harness();
    test.state.value = {
      schemaVersion: 1,
      identity: { providerId: "provider.fixture", version: "1.0.0" },
      status: "recovering",
      revision: 4,
      failures: [{ kind: "crash", message: "provider crashed", retryable: true, at: "2026-08-28T11:59:59.000Z" }],
      nextAttemptAt: null,
      stabilityDeadlineAt: null,
      quarantineReason: null,
      updatedAt: "2026-08-28T11:59:59.000Z",
    };
    const supervisor = await test.open();
    expect(supervisor.snapshot()).toMatchObject({
      status: "backoff",
      revision: 5,
      nextAttemptAt: "2026-08-28T12:00:01.000Z",
    });
    expect(test.state.value).toEqual(supervisor.snapshot());
  });

  it("rejects a corrupted persisted lifecycle instead of trusting it", async () => {
    const test = harness();
    test.state.value = {
      schemaVersion: 1,
      identity: { providerId: "provider.fixture", version: "1.0.0" },
      status: "healthy",
      revision: 2,
      failures: [],
      nextAttemptAt: "2026-08-28T12:00:01.000Z",
      stabilityDeadlineAt: null,
      quarantineReason: null,
      updatedAt: "2026-08-28T12:00:00.000Z",
    };
    await expect(test.open()).rejects.toThrow(/lifecycle is inconsistent/);
  });
});
