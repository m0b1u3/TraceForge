import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createProvider, type LlmProvider } from "@traceforge/llm";
import { runFoundationModelAcceptance, type ModelAcceptanceReport } from "./test-fixtures/foundation-model-acceptance.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function accept(extractJson: LlmProvider["extractJson"], limits: Partial<Parameters<typeof runFoundationModelAcceptance>[1]> = {}) {
  const report = await runFoundationModelAcceptance({ extractJson }, { ...limits, mode: "simulated_harness_test" });
  roots.push(report.root); return report;
}
const scripted: LlmProvider["extractJson"] = async (args) => {
  args.onUsage?.({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  const context = JSON.parse(args.user);
  const observation = context.transcript.find((entry: { kind: string }) => entry.kind === "tool");
  if (!observation) return { type: "invoke_tool", invocation: { id: "read-first", tool: "fixture.read", input: {}, rationale: "Read observation" } };
  const token = observation.summary.match(/observation-[a-f0-9]{32}/)?.[0];
  return { type: "complete", summary: `Observed ${token}`, outputs: [] };
};

describe("Foundation model acceptance harness (not a real-model certification)", () => {
  it("exercises the production model adapter against a local simulated API without claiming real inference", async () => {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, undefined);
    let apiCalls = 0;
    const server = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 131072) throw new Error("Oversized test input"); }
        const input = JSON.parse(body); apiCalls++;
        const value = await scripted({ system: input.messages[0].content, user: input.messages[1].content,
          schema: input.response_format.json_schema.schema });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "fixture-call", choices: [{ message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      } catch { response.writeHead(400); response.end("{}"); }
    });
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const provider = createProvider({ provider: "openai", model: "fixture-only", apiKey: "fixture-only-not-a-secret",
        baseUrl: `http://127.0.0.1:${address.port}/v1` });
      const report = await accept((args) => provider.extractJson(args));
      expect(report.status).toBe("passed"); expect(report.mode).toBe("simulated_harness_test"); expect(apiCalls).toBe(4);
      expect(report.calls.every((call) => call.usage?.totalTokens === 15)).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it("checks hidden observations, real tool receipts and full-host continuation while labelling simulation", async () => {
    const report = await accept(scripted);
    expect(report.status).toBe("passed"); expect(report.mode).toBe("simulated_harness_test");
    expect(report.cases).toHaveLength(2); expect(report.calls).toHaveLength(4);
    expect(report.cases[1]).toMatchObject({ toolCalls: 1, callsAfterRestart: 0, modelCalls: 2, receiptCount: 1, integrity: "ok" });
    expect(report.calls.every((call) => call.status === "completed" && call.usage?.totalTokens === 15)).toBe(true);
    expect(new Set(report.cases.map((item) => item.observationSha256)).size).toBe(2);
    const saved = JSON.parse(await readFile(join(report.root, "report.json"), "utf8")) as ModelAcceptanceReport;
    expect(saved.status).toBe("passed"); expect(saved.mode).toBe("simulated_harness_test");
  });
  it("refuses a model that claims completion without reading the tool", async () => {
    const report = await accept(async () => ({ type: "complete", summary: "Guessed result", outputs: [] }));
    expect(report.status).toBe("failed"); expect(report.failure).toBe("tool_repeated_or_not_called");
    expect(report.cases).toHaveLength(0);
  });
  it("refuses a plausible completion that omits the actual observed token", async () => {
    const report = await accept(async (args) => {
      const decision = await scripted(args) as { type: string; summary?: string };
      return decision.type === "complete" ? { type: "complete", summary: "I read the result", outputs: [] } : decision;
    });
    expect(report.status).toBe("failed"); expect(report.failure).toBe("completion_missing_observed_token");
  });
  it("caps logical API dispatches even if the Worker would ask for more", async () => {
    let calls = 0;
    const report = await accept(async (args) => { calls++; return scripted(args); }, { maximumModelCalls: 1 });
    expect(calls).toBe(1); expect(report.calls).toHaveLength(1); expect(report.status).toBe("failed");
  });
  it("sanitizes model exceptions and does not fabricate token usage", async () => {
    const report = await accept(async () => { throw new Error("credential-fixture-that-must-not-be-persisted"); });
    expect(report.status).toBe("failed"); expect(report.calls[0]?.usage).toBeNull();
    expect(await readFile(join(report.root, "report.json"), "utf8")).not.toContain("credential-fixture");
    expect((await readFile(join(report.root, "normal", "state.db"))).includes(Buffer.from("credential-fixture"))).toBe(false);
  });
  it("ends a non-cooperating model call within the host deadline", async () => {
    const report = await accept(async () => new Promise(() => {}), { modelCallTimeoutMs: 50, maximumDurationMs: 5000 });
    expect(report.status).toBe("failed"); expect(report.elapsedMs).toBeLessThan(5000);
    expect(report.calls[0]?.status).toBe("failed");
  });
  it.each(["interrupted", "deadline_exceeded"])("records %s without pretending acceptance passed", async (reason) => {
    let calls = 0;
    const report = await accept(async () => { calls++; return {}; }, reason === "interrupted"
      ? { signal: AbortSignal.abort() } : { maximumDurationMs: 100 });
    expect(report.status).toBe("failed"); expect(report.failure).toBe(reason); expect(calls).toBe(0);
    expect(JSON.parse(await readFile(join(report.root, "report.json"), "utf8"))).toMatchObject({ status: "failed", failure: reason });
  });
  it.each([{ maximumModelCalls: 0 }, { maximumDurationMs: 180001 }, { modelCallTimeoutMs: 60001 }])("rejects invalid limits %j before invoking a model", async (limits) => {
    let calls = 0;
    await expect(accept(async () => { calls++; return {}; }, limits)).rejects.toThrow("invalid_"); expect(calls).toBe(0);
  });
  it.each([{ args: [] }, { args: ["--allow-model-api", "--config", "missing-model-fixture.json"] }])("CLI refuses a non-authorized or missing configuration: %j", async ({ args }) => {
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/verify-foundation-model.mts"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI preflight exceeded deadline")); }, 10000);
      child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      child.stderr.resume(); child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); done({ code, output }); });
    });
    expect(result.code).toBe(2); expect(JSON.parse(result.output)).toMatchObject({ status: "not_run", modelApiCalls: 0 });
  });
});
