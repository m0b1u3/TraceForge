import { expect, it, vi } from "vitest";
import { ExecutionController } from "./execution-controller";

const operation = { path: "/api/desktop/conversations/first/execution", body: { commandId: "command", messageCommandId: "message", scopeRef: "scope", scenarioKind: "review", definitionVersion: 1 } };
const receipt = { version: 1, conversationId: "first", commandId: "command", operation: "dispatch", resourceId: "run" };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
it("persists before dispatch and clears only a matching successful receipt", async () => {
  const store = storage();
  const request = vi.fn(async () => { expect(store.getItem("traceforge.execution.first")).not.toBeNull(); return { status: 201, body: { runId: "run", desktopReceipt: receipt } }; });
  const controller = new ExecutionController({ protocolVersion: 1, request }, store, "first");
  expect(await controller.execute(operation)).toEqual(receipt); expect(controller.pending).toBeNull();
});
it("retains malformed, mismatched, redirected and uncertain receipts for exact retry", async () => {
  for (const response of [{ status: 200, body: {} }, { status: 302, body: {} }, { status: 408, body: { error: "timeout" } },
    { status: 200, body: { runId: "run", desktopReceipt: { ...receipt, commandId: "other" } } },
    { status: 200, body: { runId: "other", desktopReceipt: receipt } }]) {
    const store = storage(), request = vi.fn(async () => response);
    const controller = new ExecutionController({ protocolVersion: 1, request }, store, "first");
    await expect(controller.execute(operation)).rejects.toThrow("结果未知"); expect(controller.pending).toEqual(operation);
    await expect(controller.execute({ ...operation, body: { ...operation.body, commandId: "replacement" } })).rejects.toThrow("替换");
    expect(request).toHaveBeenCalledTimes(1);
    const recovered = new ExecutionController({ protocolVersion: 1, request: async () => ({ status: 200, body: { runId: "run", desktopReceipt: receipt } }) }, store, "first");
    await recovered.execute(); expect(recovered.pending).toBeNull();
  }
});
it("prevents concurrent dispatch across controllers sharing the same journal", async () => {
  const store = storage(); let finish!: (value: { status: number; body: unknown }) => void;
  const request = vi.fn(() => new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; }));
  const bridge = { protocolVersion: 1 as const, request };
  const first = new ExecutionController(bridge, store, "first"), remounted = new ExecutionController(bridge, store, "first");
  const pending = first.execute(operation);
  await expect(remounted.execute(operation)).rejects.toThrow("仍在核对");
  expect(request).toHaveBeenCalledTimes(1);
  finish({ status: 201, body: { runId: "run", desktopReceipt: receipt } }); await pending;
});
it("does not send malformed journal data or dispatch when persistence fails", async () => {
  const store = storage(), request = vi.fn(async () => ({ status: 200, body: {} }));
  const controller = new ExecutionController({ protocolVersion: 1, request }, store, "first");
  store.setItem("traceforge.execution.first", JSON.stringify({ ...operation, body: { commandId: "only-id" } }));
  await expect(controller.execute()).rejects.toThrow();
  store.removeItem("traceforge.execution.first");
  store.setItem = () => { throw new Error("storage full"); };
  await expect(controller.execute(operation)).rejects.toThrow("storage full"); expect(request).not.toHaveBeenCalled();
});
it("keeps the durable command after transport failure without echoing host internals", async () => {
  const controller = new ExecutionController({ protocolVersion: 1, request: async () => { throw new Error("private host detail"); } }, storage(), "first");
  await expect(controller.execute(operation)).rejects.toThrow("连接中断，操作结果未知");
  expect(controller.pending).toEqual(operation);
});
it("only clears explicit rejection and correlates authorization and cancellation resources", async () => {
  const store = storage();
  const rejected = new ExecutionController({ protocolVersion: 1, request: async () => ({ status: 403, body: { error: "denied" } }) }, store, "first");
  await expect(rejected.execute(operation)).rejects.toThrow("明确拒绝"); expect(rejected.pending).toBeNull();
  for (const [suffix, body, resourceId] of [
    ["authorize", { commandId: "command", scenarioKind: "review", definitionVersion: 1, scope: {}, expiresAt: "2099-01-01T00:00:00Z", confirmed: true }, "command"],
    ["cancel", { commandId: "command", runId: "run", expectedRevision: 1 }, "run"],
  ] as const) {
    const controller = new ExecutionController({ protocolVersion: 1, request: async () => ({ status: 200, body: { desktopReceipt: { ...receipt, operation: suffix, resourceId } } }) }, store, "first");
    await controller.execute({ path: `${operation.path}/${suffix}`, body }); expect(controller.pending).toBeNull();
  }
});
