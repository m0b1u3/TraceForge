import type { Fact } from "@traceforge/shared";
import type { NativeToolDef, ToolDescriptor } from "../tool.js";

export interface FactStoreLike {
  listByCase(caseId: string): Fact[];
}

export interface ReevaluateFactsInput {
  goal: string;
  focus?: string;
}

export function makeReevaluateFactsTool(
  caseId: string,
  factStore: FactStoreLike,
  suggest: (caseId: string, goal: string, focus: string | undefined, facts: Fact[]) => Promise<string>,
): ToolDescriptor {
  return {
    name: "reevaluate_facts",
    description: "Review existing Facts for the current case and suggest concrete next steps that exploit them. Call this when stuck, before pivoting, or before attempting an attack path.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Current high-level goal" },
        focus: { type: "string", description: "Optional focus area, e.g. authentication" },
      },
      required: ["goal"],
    },
    risk: "normal",
    source: "builtin",
    async execute(input) {
      const { goal, focus } = input as ReevaluateFactsInput;
      const facts = factStore.listByCase(caseId);
      const suggestion = await suggest(caseId, goal, focus, facts);
      return { ok: true, content: suggestion };
    },
  };
}
