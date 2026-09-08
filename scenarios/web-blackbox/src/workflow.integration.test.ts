import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseScenarioPackageDescriptor } from "@traceforge/scenario-sdk";
import { ScenarioProcessRuntime, type ScenarioPackageCapabilityHandler, type ToolExecutionContext } from "@traceforge/worker-runtime";

const root = resolve("scenarios/web-blackbox");
const descriptor = parseScenarioPackageDescriptor(JSON.parse(readFileSync(resolve(root, "scenario.json"), "utf8")));
const context: ToolExecutionContext = { workerId: "validator", caseId: "case", runId: "run", workId: "validation-one", scopeRef: "scope", leaseId: "lease",
  leaseExpiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "call",
  effectivePermissions: { version: 1, platform: process.platform === "darwin" ? "darwin" : "linux", filesystem: { read: [], write: [], deny: [] },
    network: "brokered", process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["test"] } };

// Real loopback HTTP + actual Scenario child process. Host ports are controlled test doubles;
// production Host/graph contract integration is covered in scenario-process-capabilities.test.ts.
class Fixture {
  state = new Map<string, { revision: number; value: any }>();
  nodes = new Map<string, any>();
  requests: Array<{ method: string; url: string; body: string }> = [];
  child!: ScenarioProcessRuntime;
  server!: Server;
  base = "";
  sequence = 0;
  prepared = false;
  failAfterRequest = false;
  failEvidence = false;
  failCheckpoint = false;
  truncated = false;
  denied = false;
  budgets: Record<string, number> = {};
  async start() {
    this.server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      this.requests.push({ method: req.method!, url: req.url!, body });
      res.setHeader("content-type", "text/html");
      if (req.url === "/forms") res.end(`<form method="POST" action="/prepare"><input name="password" type="password" value="private-form-value"><input name="selection" value="hidden-value"></form><a href="/next">Next</a>`);
      else if (req.url === "/wide") res.end(Array.from({ length: 70 }, (_, i) => `<a href="/page/${i}">link</a>`).join(""));
      else if (req.url?.startsWith("/chain/")) {
        const index = Number(req.url.split("/").at(-1));
        res.end(`<a href="/chain/0">Start</a><a href="/chain/${index + 1}">Continue</a>`);
      }
      else if (req.url === "/prepare") { this.prepared = true; res.end("prepared"); }
      else if (req.url === "/fail") { res.statusCode = 409; res.end("precondition rejected"); }
      else if (req.url === "/unstable") res.end(String(this.requests.length));
      else if (req.url === "/candidate") res.end(this.prepared ? "second representation" : "not prepared");
      else res.end("first representation");
    });
    await new Promise<void>(done => this.server.listen(0, "127.0.0.1", done));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    this.spawn(); return this;
  }
  spawn() {
    const handlers: ScenarioPackageCapabilityHandler[] = descriptor.runtime!.hostCapabilities.map(capability => ({ capability,
      actions: capability.includes("authorization") ? ["require", "authorize_resource"] : capability.includes("execution") ? ["request_http", "request_http_session"]
        : capability.includes("state") ? ["read", "compare_and_set"] : capability.includes("evidence") ? ["record_node"] : ["record", "list", "open"],
      execute: async (value, attribution) => {
        const input = value as any;
        if (capability.includes("authorization")) {
          if (this.denied || (input.value !== undefined && !input.value.startsWith(`${this.base}/`))) throw new Error("not authorized");
          return { output: { id: "scope", canonicalValue: input.value, scopePayload: { urlPrefixes: [`${this.base}/`], budgets: this.budgets } }, refs: [] };
        }
        if (capability.includes("state")) {
          if (input.operation === "read") return { output: structuredClone(this.state.get(input.key) ?? null), refs: [] };
          if (this.failCheckpoint && input.key === "web.investigation.v1" && input.value.candidates.some((item: any) => item.observations.length && item.pending === null)) throw new Error("checkpoint unavailable");
          if ((this.state.get(input.key)?.revision ?? 0) !== input.expectedRevision) throw new Error("CAS conflict");
          const stored = { revision: input.expectedRevision + 1, value: structuredClone(input.value) };
          this.state.set(input.key, stored); return { output: structuredClone(stored), refs: [] };
        }
        if (capability.includes("execution")) {
          if (!input.url.startsWith(`${this.base}/`)) throw new Error("test broker target denied");
          const response = await fetch(input.url, { method: input.method, headers: input.headers, redirect: "manual",
            ...(["GET", "HEAD"].includes(input.method) ? {} : { body: Buffer.from(input.bodyBase64 ?? "", "base64") }) });
          const bytes = Buffer.from(await response.arrayBuffer());
          if (this.failAfterRequest) throw new Error("response receipt lost after delivery");
          const id = `request-${this.requests.length}`;
          return { output: { receipt: { id }, status: response.status, headers: [...response.headers].map(([name, value]) => ({ name, value })),
            bodyBase64: bytes.toString("base64"), responseBytes: bytes.length, bodyTruncated: this.truncated }, refs: [`network-receipt:${id}`] };
        }
        if (capability.includes("evidence")) {
          if (this.failEvidence) throw new Error("graph write failed");
          // Deliberately reject duplicate nodes, as the real graph does under a new command identity.
          if (this.nodes.has(input.node.id)) throw new Error("duplicate graph node");
          this.nodes.set(input.node.id, structuredClone(input.node));
          return { output: {}, refs: [`knowledge-node:${input.node.id}`] };
        }
        if (capability.includes("artifacts")) return { output: { id: "artifact", contentRef: input.contentRef }, refs: [input.contentRef] };
        throw new Error(`Unexpected ${capability} for ${attribution.workId}`);
      },
    }));
    this.child = new ScenarioProcessRuntime({ manifest: descriptor.runtime!, capabilityHandlers: handlers,
      launch: { executable: process.execPath, arguments: [resolve(root, "runtime/main.mjs")], workingDirectory: root, attestation: { sandboxed: false, backend: "test-only", network: "deny" } },
      transport: { allowUnsandboxedDevelopment: true, requestTimeoutMs: 5000 } });
  }
  async call(name: string, input: unknown, overrides: Partial<ToolExecutionContext> = {}) {
    const tool = (await this.child.discover()).find(item => item.name === name)!;
    return JSON.parse((await tool.execute(input, { ...context, idempotencyKey: `call-${++this.sequence}`, ...overrides })).raw);
  }
  async register(id = "first") {
    const observed = await this.call("web.surface.explore", { seeds: [`${this.base}/`], maxRequests: 1 });
    const basis = observed.observations[0]?.networkReceipt ?? this.state.get("web.surface.v1")!.value.observations[0].networkReceipt;
    return this.call("web.hypothesis.register", { candidateId: id, statement: `${id} candidate`, basisRefs: [basis] });
  }
  plan() {
    return { prepare: [{ request: { url: `${this.base}/prepare`, method: "POST", purpose: "Prepare one test resource; changes test state", bodyBase64: Buffer.from("non-sensitive-input").toString("base64") }, expectedStatuses: [200] }],
      baseline: { url: `${this.base}/` }, candidate: { url: `${this.base}/candidate` }, changedCondition: "Compare the second resource with the baseline", rounds: 2 };
  }
  review(observed: any, outcome = "supported") {
    return { candidateId: observed.id, outcome, causalMechanism: "Controlled representation difference; mechanism still subject to graph review",
      expectedBoundary: "Test resource access expectation", securityImpact: "Observed test representation; no production impact established",
      alternatives: "Session evolution and time-dependent state considered", refs: observed.observations.flatMap((item: any) => item.refs).slice(0, 8) };
  }
  async restart() { await this.child.close(); this.spawn(); }
  async close() { await this.child?.close(); this.server?.closeAllConnections(); await new Promise<void>(done => this.server?.close(() => done())); }
}
const fixtures: Fixture[] = [];
async function fixture() { const value = new Fixture(); fixtures.push(value); return value.start(); }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(item => item.close())); });

describe("Web HTTP investigation workflow", () => {
  it("prioritizes HTTP, Session and discovery observations with caller-selected literal hints",async()=>{
    const f=await fixture();
    for(const tool of ["web.http.request","web.session.request"]){
      const result=await f.call(tool,{url:`${f.base}/`,interestTerms:["representation"],...(tool==="web.session.request"?{sessionId:"approved"}:{})});
      expect(result.contextHighlights.groups[0].representative.signals.termMatch).toBe(true);
      expect(result.contextHighlights.groups[0].representative.refs[0]).toMatch(/^network-receipt:/);
    }
    const surface=await f.call("web.surface.explore",{seeds:[`${f.base}/`],maxRequests:1,interestTerms:["representation"]});
    expect(surface.contextHighlights.groups[0].representative.signals.termMatch).toBe(true);
  });
  it("rejects mixed-dimension matrices before dispatch",async()=>{
    const f=await fixture();f.budgets={variants:2};await f.register();const count=f.requests.length;
    const {candidate,...base}=f.plan();
    await expect(f.call("web.validation.execute",{candidateId:"first",plan:{...base,candidates:[candidate,{url:base.baseline.url,method:"HEAD"}]}})).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
  });
  it("runs a declared variant matrix across a child restart without replaying observations", async () => {
    const f=await fixture(); f.budgets={variants:2,requestsPerCall:12,totalRequests:32};
    await f.register();
    const {candidate,...base}=f.plan();
    const plan={...base,candidates:[candidate,{url:`${f.base}/next`}]};
    const first=await f.call("web.validation.execute",{candidateId:"first",plan,maxRequests:5});
    expect(first.observations).toHaveLength(5);
    const count=f.requests.length;
    await f.restart();
    const completed=await f.call("web.validation.execute",{candidateId:"first",plan,maxRequests:12});
    expect(completed).toMatchObject({status:"observed"});
    expect(completed.observations).toHaveLength(9);
    expect(f.requests).toHaveLength(count+4);
    expect(completed.variantAssessments).toHaveLength(2);
    await f.call("web.validation.execute",{candidateId:"first",plan,maxRequests:12});
    expect(f.requests).toHaveLength(count+4);
  });

  it("reads an empty investigation without making requests or changing state", async () => {
    const f = await fixture();
    expect(await f.call("web.investigation.snapshot", {})).toMatchObject({ handoff: { nextAction: "map_authorized_surface", advisoryOnly: true } });
    expect(f.state.size).toBe(0); expect(f.requests).toHaveLength(0);
    f.denied = true;
    await expect(f.call("web.investigation.snapshot", {})).rejects.toThrow();
  });

  it("retains passive forms without submitting or crawling their action and inventories Sessions separately", async () => {
    const f = await fixture();
    const result = await f.call("web.surface.explore", { seeds: [`${f.base}/forms`], maxRequests: 2 });
    expect(result.observations[0].forms).toEqual([expect.objectContaining({ action: `${f.base}/prepare`, method: "POST",
      automaticSubmission: false, fields: [{ name: "password", type: "password" }, { name: "selection", type: "input" }] })]);
    expect(JSON.stringify(result)).not.toMatch(/private-form-value|hidden-value/);
    expect(f.requests.map(item => item.url)).toEqual(["/forms", "/next"]);
    const authenticated = await f.call("web.surface.explore", { seeds: [`${f.base}/`], sessionId: "approved-session", maxRequests: 1 });
    await f.call("web.hypothesis.register", { candidateId: "session-candidate", statement: "A separate Session observation",
      surfaceSessionId: "approved-session", basisRefs: [authenticated.observations[0].networkReceipt] });
    const before = JSON.stringify([...f.state]); const count = f.requests.length;
    await f.restart();
    const snapshot = await f.call("web.investigation.snapshot", {});
    expect(snapshot.coverage.inventories).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "anonymous", visitedCount: 2 }), expect.objectContaining({ mode: "session", sessionId: "approved-session", visitedCount: 1 }),
    ]));
    expect(snapshot.handoff).toMatchObject({ nextAction: "schedule_one_validation_work", queuedCandidateIds: ["session-candidate"] });
    expect((await f.call("web.report.build", {})).coverage.inventories).toHaveLength(2);
    expect(f.requests).toHaveLength(count); expect(JSON.stringify([...f.state])).toBe(before);
    await expect(f.call("web.hypothesis.register", { candidateId: "session-candidate", statement: "A separate Session observation",
      basisRefs: [authenticated.observations[0].networkReceipt] })).rejects.toThrow();
  });

  it("stops at the cumulative visit limit without evicting visited URLs or hiding omitted observations", async () => {
    const f = await fixture();
    let result: any;
    for (let batch = 0; batch < 8; batch++) result = await f.call("web.surface.explore", { seeds: batch ? [] : [`${f.base}/chain/0`], maxRequests: 8 });
    expect(result.coverage).toMatchObject({ visitedCount: 64, queuedCount: 1, capacityExhausted: true, complete: false,
      omissions: { observations: 48, legacyUnknown: false } });
    const count = f.requests.length;
    await f.restart();
    await f.call("web.surface.explore", { seeds: [`${f.base}/chain/0`], maxRequests: 8 });
    expect(f.requests).toHaveLength(count);
    expect((await f.call("web.report.build", {})).coverage.inventories[0].omissions.observations).toBe(48);
  });

  it("reports queue overflow and document-hint truncation in the final coverage", async () => {
    const f = await fixture();
    await f.call("web.surface.explore", { seeds: [`${f.base}/wide`], maxRequests: 1, maxLinksPerPage: 64 });
    const report = await f.call("web.report.build", {});
    expect(report.coverage.inventories[0]).toMatchObject({ queuedCount: 32, complete: false, omissions: { queuedUrls: 32, documentHints: 1 } });
    expect(f.requests).toHaveLength(1);
  });

  it("does not dispatch a queued validation while a later surface effect is unknown", async () => {
    const f = await fixture(); await f.register();
    f.failAfterRequest = true;
    await expect(f.call("web.surface.explore", { seeds: [`${f.base}/next`], maxRequests: 1 })).rejects.toThrow();
    f.failAfterRequest = false;
    const count = f.requests.length;
    await f.restart();
    await expect(f.call("web.validation.execute", { candidateId: "first", plan: f.plan() })).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
  });

  it("runs discovery, separate hypotheses, preparation, restart, comparison, review and report as one flow", async () => {
    const f = await fixture();
    const first = await f.register(), second = await f.register("second");
    expect(first.hypothesisId).not.toBe(second.hypothesisId);
    const plan = f.plan();
    const partial = await f.call("web.validation.execute", { candidateId: "first", plan, maxRequests: 2 });
    expect(partial).toMatchObject({ status: "running", observations: [expect.objectContaining({ stage: "prepare:0" }), expect.objectContaining({ stage: "baseline:0" })] });
    await f.restart();
    expect((await f.call("web.investigation.snapshot", {})).handoff).toMatchObject({ nextAction: "continue_original_validation_work", originalWorkId: "validation-one" });
    await expect(f.call("web.validation.execute", { candidateId: "second", plan })).rejects.toThrow();
    const observed = await f.call("web.validation.execute", { candidateId: "first", plan });
    expect(observed).toMatchObject({ status: "observed", assessment: "repeatable_difference", findingVerified: false });
    expect((await f.call("web.investigation.snapshot", {})).handoff.nextAction).toBe("review_active_candidate");
    expect(f.requests.filter(item => item.method === "POST")).toHaveLength(1);
    const count = f.requests.length;
    await f.call("web.validation.execute", { candidateId: "first", plan });
    expect(f.requests).toHaveLength(count);
    await f.call("web.validation.review", f.review(observed), { workId: "review-work" });
    await f.call("web.validation.review", f.review(observed), { workId: "review-work" });
    const report = await f.call("web.report.build", {}, { workId: "report-work" });
    expect(report).toMatchObject({ verifiedFindings: [], supportedCandidates: [expect.objectContaining({ id: "first" })], unresolved: [expect.objectContaining({ id: "second", status: "queued" })], coverage: { complete: false } });
    expect(f.requests).toHaveLength(count);
    const failed = await f.call("web.validation.execute", { candidateId: "second", plan: { ...plan, prepare: [{ ...plan.prepare[0], request: { ...plan.prepare[0]!.request, url: `${f.base}/fail` } }] } }, { workId: "validation-two" });
    expect(failed).toMatchObject({ status: "stopped", assessment: "precondition_failed" });
    expect(failed.observations).toHaveLength(1);
    await f.call("web.validation.review", f.review(failed, "inconclusive"));
    expect((await f.call("web.report.build", {})).unresolved).toEqual([expect.objectContaining({ id: "second", review: expect.objectContaining({ outcome: "inconclusive" }) })]);
    const persisted = JSON.stringify(f.state.get("web.investigation.v1"));
    expect(persisted).not.toContain("non-sensitive-input");
    expect(persisted).not.toContain("second representation");
  });

  it.each(["request", "evidence", "checkpoint"])("does not replay a delivered preparation after %s failure", async failure => {
    const f = await fixture(); await f.register(); await f.register("second");
    f.failAfterRequest = failure === "request"; f.failEvidence = failure === "evidence"; f.failCheckpoint = failure === "checkpoint";
    await expect(f.call("web.validation.execute", { candidateId: "first", plan: f.plan() })).rejects.toThrow();
    f.failAfterRequest = f.failEvidence = f.failCheckpoint = false; await f.restart();
    const interrupted = await f.call("web.validation.execute", { candidateId: "first", plan: f.plan() });
    expect(interrupted).toMatchObject({ status: "interrupted", pending: "prepare:0" });
    expect(f.requests.filter(item => item.method === "POST")).toHaveLength(1);
    await f.call("web.validation.review", { ...f.review(interrupted, "inconclusive"), refs: interrupted.basisRefs });
    await expect(f.call("web.validation.execute", { candidateId: "second", plan: f.plan() })).rejects.toThrow();
    expect((await f.call("web.report.build", {})).activeCandidateId).toBe("first");
  });

  it("rejects forged basis and review references, changed plans, wrong Work and wrong scope", async () => {
    const f = await fixture();
    await expect(f.call("web.hypothesis.register", { candidateId: "fake", statement: "candidate", basisRefs: ["network-receipt:fake"] })).rejects.toThrow();
    await f.register(); const plan = f.plan();
    await f.call("web.validation.execute", { candidateId: "first", plan, maxRequests: 1 });
    const count = f.requests.length;
    for (const [input, overrides] of [
      [{ candidateId: "first", plan: { ...plan, rounds: 3 } }, {}],
      [{ candidateId: "first", plan }, { workId: "another-work" }],
      [{ candidateId: "first", plan }, { scopeRef: "another-scope" }],
    ] as const) await expect(f.call("web.validation.execute", input, overrides)).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
    const observed = await f.call("web.validation.execute", { candidateId: "first", plan });
    await expect(f.call("web.validation.review", { ...f.review(observed), refs: observed.observations.find((item: any) => item.stage === "candidate:0").refs })).rejects.toThrow();
    await expect(f.call("web.validation.review", { ...f.review(observed), refs: ["network-receipt:invented"] })).rejects.toThrow();
  });

  it.each(["unstable", "truncated", "same"])("retains %s observations without a supported finding", async mode => {
    const f = await fixture(); await f.register(); f.truncated = mode === "truncated";
    const plan = { ...f.plan(), prepare: [], candidate: mode === "same" ? { url: `${f.base}/`, headers: { Accept: "text/html" } } : { url: `${f.base}/${mode === "unstable" ? "unstable" : "candidate"}` } };
    const observed = await f.call("web.validation.execute", { candidateId: "first", plan });
    expect(observed.assessment).toBe(mode === "same" ? "no_observed_difference" : `${mode}_observations`);
    await expect(f.call("web.validation.review", f.review(observed))).rejects.toThrow();
    await f.call("web.validation.review", f.review(observed, "inconclusive"));
    expect((await f.call("web.report.build", {})).verifiedFindings).toEqual([]);
  });

  it("validates the entire plan and authorization before sending a preparation", async () => {
    const f = await fixture(); await f.register(); const count = f.requests.length;
    for (const plan of [
      { ...f.plan(), candidate: { url: `${f.base}/candidate`, method: "HEAD" } },
      { ...f.plan(), prepare: [{ request: { url: `${f.base}/prepare`, method: "POST" }, expectedStatuses: [200] }] },
      { ...f.plan(), baseline: { url: `${f.base}/`, headers: { Cookie: "raw-secret" } } },
      { ...f.plan(), candidate: { url: "https://outside.invalid/resource" } },
      { ...f.plan(), prepare: [...f.plan().prepare, { request: { url: `${f.base}/prepare`, method: "POST", purpose: "Second preparation", sessionId: "session", secretBody: { format: "invalid", fields: {} } }, expectedStatuses: [200] }] },
    ]) await expect(f.call("web.validation.execute", { candidateId: "first", plan })).rejects.toThrow();
    f.denied = true;
    await expect(f.call("web.validation.execute", { candidateId: "first", plan: f.plan() })).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
  });

  it("fences an unknown discovery request and reports incomplete coverage", async () => {
    const f = await fixture(); f.failAfterRequest = true;
    await expect(f.call("web.surface.explore", { seeds: [`${f.base}/`], maxRequests: 1 })).rejects.toThrow();
    f.failAfterRequest = false; await f.restart();
    expect(await f.call("web.surface.explore", { seeds: [], maxRequests: 1 })).toMatchObject({ status: "interrupted" });
    expect((await f.call("web.investigation.snapshot", {})).handoff).toMatchObject({ nextAction: "reconcile_unknown_outcomes", pendingInventories: ["web.surface.v1"] });
    expect(f.requests).toHaveLength(1);
    expect((await f.call("web.report.build", {})).coverage.complete).toBe(false);
  });

  it("preserves uncertain registration and review writes without inventing completed records", async () => {
    const f = await fixture(); await f.register();
    f.failEvidence = true;
    await expect(f.register("second")).rejects.toThrow();
    f.failEvidence = false;
    await expect(f.register("second")).rejects.toThrow();
    expect((await f.call("web.report.build", {})).unresolved).toEqual(expect.arrayContaining([expect.objectContaining({id:"second",status:"registration_unconfirmed"})]));
    const observed = await f.call("web.validation.execute", {candidateId:"first",plan:f.plan()});
    f.failEvidence = true;
    await expect(f.call("web.validation.review", f.review(observed))).rejects.toThrow();
    f.failEvidence = false;
    await expect(f.call("web.validation.review", f.review(observed))).rejects.toThrow();
    const report = await f.call("web.report.build", {});
    expect(report.supportedCandidates).toEqual([]);
    expect(report.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({id:"first",status:"review_unconfirmed"})]));
  });

  it("uses CAS to stop competing validation invocations before duplicate requests", async () => {
    const f = await fixture(); await f.register(); await f.register("second");
    const results = await Promise.allSettled([
      f.call("web.validation.execute", {candidateId:"first",plan:f.plan(),maxRequests:1}),
      f.call("web.validation.execute", {candidateId:"second",plan:f.plan(),maxRequests:1}, {workId:"other-work"}),
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(f.requests.filter(item => item.method === "POST")).toHaveLength(1);
  });

  it("keeps refuted review assessments separate from verified findings", async () => {
    const f = await fixture(); await f.register();
    const observed = await f.call("web.validation.execute", {candidateId:"first",plan:f.plan()});
    await f.call("web.validation.review", {...f.review(observed,"refuted"),causalMechanism:"The difference is an expected representation, not the proposed access effect"});
    const report = await f.call("web.report.build", {});
    expect(report).toMatchObject({refutedCandidates:[expect.objectContaining({id:"first"})],supportedCandidates:[],verifiedFindings:[],verifiedFindingCoverage:"not_loaded"});
  });

  it("exposes workflow capabilities through Scenario roles and retains the single validation Work contract", () => {
    const json=JSON.parse(readFileSync(resolve(root,"scenario.json"),"utf8"));
    const pools=json.definition.agentTopology.workerPools;
    expect(pools.find((pool:any)=>pool.role==="validator").capabilities).toEqual(expect.arrayContaining(["web.validation.execute","web.validation.review"]));
    expect(pools.find((pool:any)=>pool.role==="researcher").capabilities).not.toContain("web.validation.execute");
    expect(pools.find((pool:any)=>pool.role==="reporter").capabilities).toContain("web.report.build");
    expect(json.definition.workKinds.find((kind:any)=>kind.id==="validation")).toMatchObject({maximumActiveItems:1,minimumHypothesisRefs:1});
  });
});
