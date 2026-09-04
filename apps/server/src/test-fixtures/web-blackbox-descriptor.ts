import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseScenarioPackageDescriptor } from "@traceforge/scenario-sdk";

export const WEB_BLACKBOX_TEST_PACKAGE = parseScenarioPackageDescriptor(JSON.parse(
  readFileSync(resolve("scenarios/web-blackbox/scenario.json"), "utf8"),
));

export const WEB_BLACKBOX_SCENARIO = WEB_BLACKBOX_TEST_PACKAGE.definition;
export const WEB_BLACKBOX_CAPABILITIES = {
  scopeRead: "scope.read",
  evidenceWrite: "evidence.write",
  browserNavigate: "web.surface.explore",
  trafficRead: "web.traffic.read",
  requestReplay: "web.request.replay",
  artifactAnalyze: "web.session.use",
  reportWrite: "report.write",
} as const;
