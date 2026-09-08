import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalExecutionNode, MacosProcessLauncher } from "@traceforge/execution-node";
import { RunWorkspace, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ExecutionNodeProcessTool } from "./worker-execution-adapters.js";

describe.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1")("Run Workspace through real macOS native execution", () => {
  let root: string, node: LocalExecutionNode, workspace: RunWorkspace;
  beforeAll(() => {
    expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
    root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-workspace-native-")));
    const path = realpathSync(resolve("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox"));
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    node = new LocalExecutionNode(new MacosProcessLauncher({ path, sha256 }), { platform: "darwin", architecture: "arm64",
      sandboxBackends: ["traceforge-macos-native"], sandboxMeasurements: { "traceforge-macos-native": sha256 }, acceptedSampledResourceBackends: ["traceforge-macos-native"],
      capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: false, resourcePolicy: "sampled_terminate", signals: ["terminate", "kill"] } } });
    workspace = new RunWorkspace(join(root, "runs"), new ExecutionNodeProcessTool(node), () => {});
  });
  afterAll(async () => { if (node) await node.shutdown(); if (root) rmSync(root, { recursive: true, force: true }); });
  async function call(op: string, input: unknown, runId = "run") {
    const context: ToolExecutionContext = { caseId: "case", runId, workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), idempotencyKey: randomUUID(),
      effectivePermissions: { ...workspace.profile("case", runId, `workspace_${op}`, true), sources: ["native-test"] } };
    return workspace.tools().find(tool => tool.name === `workspace_${op}`)!.execute(input, context);
  }
  it("writes, runs, reads output, edits and reruns without a model or unrestricted launcher", async () => {
    const first = JSON.parse((await call("write", { path: "scripts/run.sh", content: "printf first > result.txt\nprintf first", expectedDigest: null })).raw);
    expect(await call("execute", { path: "scripts/run.sh", expectedDigest: first.digest })).toMatchObject({ status: "succeeded", raw: "first", metadata: { enforcement: { network: "deny", processTreeEmptyBarrier: true } } });
    expect(JSON.parse((await call("read", { path: "result.txt" })).raw).content).toBe("first");
    const second = JSON.parse((await call("write", { path: "scripts/run.sh", content: "printf second > result.txt\nprintf second", expectedDigest: first.digest })).raw);
    expect(await call("execute", { path: "scripts/run.sh", expectedDigest: second.digest })).toMatchObject({ status: "succeeded", raw: "second" });
    expect(JSON.parse((await call("read", { path: "result.txt" })).raw).content).toBe("second");
  }, 20_000);
  it("denies reading and writing outside the Run, including another Run", async () => {
    const outside = join(root, "private.txt"); writeFileSync(outside, "never-disclose");
    await call("write", { path: "other.txt", content: "another-run-secret", expectedDigest: null }, "other");
    const script = JSON.parse((await call("write", { path: "boundary.sh", content: 'if /bin/cat "$1"; then exit 9; fi\nif printf changed > "$1"; then exit 10; fi\nprintf denied', expectedDigest: null })).raw);
    for (const path of [outside, join(workspace.root("case", "other"), "other.txt")]) {
      const result = await call("execute", { path: "boundary.sh", expectedDigest: script.digest, arguments: [path] });
      expect(result.status).toBe("succeeded"); expect(result.raw).toContain("denied");
      expect(result.raw).not.toMatch(/never-disclose|another-run-secret/);
    }
    expect(readFileSync(outside, "utf8")).toBe("never-disclose");
  }, 20_000);
});
