import { describe, expect, it, vi } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { BrokeredHttpGateway, type BrokeredHttpTransport } from "./network-broker.js";
import type { BrokeredHttpRequest, ExecutionAttribution, StartProcessRequest } from "./protocol.js";
import { LocalExecutionNode, type ProcessLauncher } from "./runtime.js";

const platform: EffectivePermissionProfile["platform"] = process.platform === "win32"
  ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const now = "2026-08-27T08:00:00.000Z";

class DeniedLauncher implements ProcessLauncher {
  async launch(_request: StartProcessRequest): Promise<never> {
    throw new Error("not used");
  }
}

function attribution(patch: Partial<ExecutionAttribution> = {}): ExecutionAttribution {
  return {
    caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", scopeRef: "scope_1",
    leaseId: "lease_1", leaseExpiresAt: "2026-08-27T09:00:00.000Z", actionId: "action_1",
    idempotencyKey: "effect_1", ...patch,
  };
}

function permissions(network: EffectivePermissionProfile["network"] = "brokered"): EffectivePermissionProfile {
  return {
    version: 1, platform, filesystem: { read: [], write: [], deny: [] }, network,
    process: { access: "deny", interactive: false, background: false },
    secrets: "handles_only", sources: ["test"],
  };
}

function request(patch: Partial<BrokeredHttpRequest> = {}): BrokeredHttpRequest {
  return {
    requestId: "http_1", attribution: attribution(), permissions: permissions(),
    authorizationAction: "network.request", url: "https://authorized.example/api", method: "GET",
    headers: { Accept: "application/json" }, timeoutMs: 10_000, responseLimitBytes: 1024,
    ...patch,
  };
}

function fixture(options: { authorize?: () => never; transport?: BrokeredHttpTransport } = {}) {
  const authorize = vi.fn(options.authorize ?? (() => ({
    authorizationRef: "scope_1", canonicalUrl: "https://authorized.example/api",
    expiresAt: "2026-08-27T09:00:00.000Z",
  })));
  const transport = vi.fn<BrokeredHttpTransport>(options.transport ?? (async () => ({
    status: 302,
    headers: [{ name: "location", value: "https://outside.example/" }],
    body: Buffer.from("redirect"),
    bodyTruncated: false,
  })));
  const broker = new BrokeredHttpGateway({ authorizer: { authorize }, transport, now: () => now });
  const node = new LocalExecutionNode(new DeniedLauncher(), {
    id: "network_node", platform, architecture: "test", now: () => now,
    sandboxBackends: [], httpBroker: broker,
    capabilities: {
      process: { spawn: false, stdio: false, tty: false, adoption: false, resourceLimits: false, signals: [] },
    },
  });
  return { authorize, transport, node };
}

describe("Execution Node brokered HTTP gateway", () => {
  it("re-authorizes attributed requests, returns an audit receipt, and replays idempotently", async () => {
    const { authorize, transport, node } = fixture();
    const first = await node.requestHttp(request());
    const replay = await node.requestHttp(request());

    expect(first).toMatchObject({ status: 302, bodyTruncated: false, replayed: false });
    expect(first.receipt).toMatchObject({
      nodeId: "network_node", authorizationRef: "scope_1", authorizationAction: "network.request",
      url: "https://authorized.example/api", status: 302, redirectFollowed: false,
      attribution: { caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1" },
    });
    expect(replay.replayed).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("fails closed for direct permission, expired leases, denied scope, and reused keys with changed input", async () => {
    const { authorize, transport, node } = fixture();
    await expect(node.requestHttp(request({ permissions: permissions("direct") }))).rejects.toThrow(/brokered-only/);
    await expect(node.requestHttp(request({ attribution: attribution({ leaseExpiresAt: now, idempotencyKey: "expired" }) })))
      .rejects.toThrow(/lease .* expired/);
    expect(authorize).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();

    await node.requestHttp(request());
    await expect(node.requestHttp(request({ url: "https://authorized.example/other" }))).rejects.toThrow(/reused with different input/);

    const denied = fixture({ authorize: () => { throw new Error("target outside authorization"); } });
    await expect(denied.node.requestHttp(request({ attribution: attribution({ idempotencyKey: "denied" }) })))
      .rejects.toThrow(/outside authorization/);
    expect(denied.transport).not.toHaveBeenCalled();
  });

  it("rejects tunneling headers and transport responses that exceed broker limits", async () => {
    const { node, transport } = fixture();
    await expect(node.requestHttp(request({ headers: { Host: "outside.example" } }))).rejects.toThrow(/header Host is not allowed/);
    expect(transport).not.toHaveBeenCalled();

    const oversized = fixture({ transport: async () => ({
      status: 200, headers: [], body: Buffer.alloc(1025), bodyTruncated: false,
    }) });
    await expect(oversized.node.requestHttp(request())).rejects.toThrow(/exceeded the response body limit/);
  });
});
