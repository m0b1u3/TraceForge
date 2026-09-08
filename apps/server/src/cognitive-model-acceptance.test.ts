import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCognitiveModelAcceptance } from "./test-fixtures/cognitive-model-acceptance.js";

it("labels simulation while requiring real compaction in all three role adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "traceforge-cognition-test-"));
  let calls = 0;
  try {
    const report = await runCognitiveModelAcceptance({async extractJson(args) {
      calls++;
      const context = JSON.parse(args.user);
      expect(context.compactedText.trust).toBe("untrusted_summary");
      if (calls === 1) return {action:"wait", rationale:"Existing work"};
      if (calls === 2) return {action:"continue", rationale:"No contrary evidence"};
      const text = context.compactedText.entries.map((item: {text:string}) => item.text).join(" ");
      return {type:"complete", summary:text.match(/Observed token: (observed-[a-f0-9]+)\./)![1], outputs:[]};
    }}, {outputParent:root, mode:"simulated_harness_test", modelIdentity:{provider:"fixture",name:"deterministic"}});
    expect(report.status).toBe("passed"); expect(report.mode).toBe("simulated_harness_test");
    expect(report.cacheReused).toBe(true); expect(report.calls.map(call=>call.role)).toEqual(["planner","observer","worker"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
