import { resolve, join } from "node:path";
import { createProvider, loadLlmConfig } from "../packages/llm/src/index.js";
import { runFoundationModelAcceptance } from "../apps/server/src/test-fixtures/foundation-model-acceptance.js";

// No fake-model switch: a successful invocation of this CLI must cross the configured model API.
const args = process.argv.slice(2);
let configPath = resolve("config/llm.json"), outputParent = resolve("data/foundation-model-acceptance"), allowed = false;
const seen = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i]!;
  if (seen.has(key)) throw new Error("Duplicate model acceptance argument"); seen.add(key);
  if (key === "--allow-model-api") allowed = true;
  else if (["--config", "--output-parent"].includes(key) && args[i + 1] && !args[i + 1]!.startsWith("--")) {
    const value = resolve(args[++i]!); if (key === "--config") configPath = value; else outputParent = value;
  } else throw new Error("Usage: verify:foundation:model --allow-model-api [--config path] [--output-parent path]");
}
const config = loadLlmConfig(configPath);
if (!allowed || !config?.apiKey?.trim() || !config.model.trim()) {
  console.log(JSON.stringify({ status: "not_run", reason: !allowed ? "explicit_model_api_opt_in_required" : "model_configuration_missing_or_invalid",
    modelApiCalls: 0 }));
  process.exitCode = 2;
} else {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    console.log(JSON.stringify({ status: "starting", mode: "external_model", provider: config.provider, model: config.model,
      maximumLogicalModelCalls: 6, maximumDurationMs: 120000, modelCallTimeoutMs: 30000 }));
    const report = await runFoundationModelAcceptance(createProvider(config), { mode: "external_model", outputParent,
      modelIdentity: { provider: config.provider, name: config.model }, signal: stop.signal });
    console.log(JSON.stringify({ status: report.status, report: join(report.root, "report.json"), failure: report.failure,
      logicalModelCalls: report.calls.length, elapsedMs: report.elapsedMs }));
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ status: "failed", reason: "model_acceptance_setup_or_report_failed" }));
    process.exitCode = 1;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
