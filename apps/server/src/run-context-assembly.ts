import { CognitiveContextDistiller, type ContextCompactionPolicy } from "@traceforge/cognitive-runtime";
import type { RunContextInput, RunContextPolicy } from "./run-context-policy.js";

/** Shared role assembly: authorize before compaction and retain all structural identifiers. */
export async function assembleRunContext(input: RunContextInput & { maximumGraphNodes: number; maximumRunItems: number },
  role: "planner" | "observer", distiller: CognitiveContextDistiller, policy?: RunContextPolicy, compaction?: ContextCompactionPolicy) {
  const projection = policy ? await policy.prepare(input, role) : { ...input, manifest: {} };
  const context = distiller.distillRun(projection.run, projection.graph, projection.recentEvents, {
    maximumGraphNodes: compaction ? Math.max(1, projection.graph.nodes.length) : input.maximumGraphNodes,
    maximumRunItems: compaction ? Math.max(1, projection.run.workItems.length, projection.run.outputs.length, projection.run.directives.length) : input.maximumRunItems,
    maximumRecentEvents: projection.recentEvents.length || 1,
  });
  return { ...context, manifest: { ...context.manifest, ...projection.manifest } };
}
