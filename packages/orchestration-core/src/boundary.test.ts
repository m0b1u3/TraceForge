import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("orchestration-core scenario boundary", () => {
  it("contains no concrete scenario identities or Scenario Package imports", () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const productionSources = readdirSync(sourceRoot)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => ({ name, content: readFileSync(join(sourceRoot, name), "utf8") }));

    for (const source of productionSources) {
      expect(source.content, source.name).not.toMatch(/@traceforge\/scenario-|web_blackbox|code_audit|red_team_lateral/);
    }
  });
});
