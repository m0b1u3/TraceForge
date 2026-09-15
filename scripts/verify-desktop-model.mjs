// Explicit opt-in, OS-encrypted desktop credentials, neutral isolated tools.
// Run under Electron after prepare:runtime; restore Node ABI afterwards.
import { app, safeStorage } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { register } from "../apps/server/dist/development-loader.js";
register();
const args = process.argv.slice(2);
if (![3,5].includes(args.length) || args[0] !== "--allow-model-api" || args[1] !== "--config-directory" || (args.length === 5 && (args[3] !== "--suite" || !["cognitive","recall","planning","rolling","desktop-memory","desktop-stream"].includes(args[4])))) {
  console.error("Use --allow-model-api --config-directory <desktop-config-directory>"); app.exit(2);
} else {
  app.whenReady().then(async () => {
  let accounts;
  try {
    const configDirectory = resolve(args[2]);
    const { ModelAccounts, ModelAccountManifestSchema, defaultModelAccounts } = await import("../apps/server/src/model-settings-host.ts");
    const { LlmConfigService } = await import("../apps/server/src/llm-config-service.ts");
    const { createModelTokenStore } = await import("../apps/desktop/src/model-token-store.ts");
    const { runFoundationModelAcceptance } = await import("../apps/server/src/test-fixtures/foundation-model-acceptance.ts");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable");
    const manifestPath = join(configDirectory, "model-accounts.json");
    if (existsSync(manifestPath) && statSync(manifestPath).size > 65536) throw new Error("manifest_exceeds_limit");
    const manifest = existsSync(manifestPath) ? ModelAccountManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8"))) : defaultModelAccounts();
    accounts = new ModelAccounts(manifest, createModelTokenStore(join(configDirectory, "model-tokens.bin"), {
      available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
    }), { fetch: async (input, init) => {
      const started = Date.now();
      try {
        const response = await fetch(input, init);
        console.log(JSON.stringify({ event: "model_transport", status: response.status, elapsedMs: Date.now() - started }));
        return response;
      } catch (error) {
        const code = error?.cause?.code;
        console.log(JSON.stringify({ event: "model_transport_failed", code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "REDACTED", elapsedMs: Date.now() - started }));
        throw error;
      }
    } });
    const configPath = join(configDirectory, "llm.json");
    const service = new LlmConfigService(configPath, { gateway: accounts.gateway, secretStore: {
      load() { const path = join(configDirectory, "llm-secrets.bin"); return existsSync(path) ? JSON.parse(safeStorage.decryptString(readFileSync(path))) : { alternativeRoutes: {} }; },
      save() { throw new Error("Acceptance does not modify model settings"); },
    } });
    service.initializeFromConfig();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const recallLimits = args[4] === "desktop-stream" ? (await import("../apps/server/src/test-fixtures/desktop-stream-acceptance.ts")).desktopStreamLimits
      : args[4] === "desktop-memory" ? (await import("../apps/server/src/test-fixtures/desktop-memory-acceptance.ts")).desktopMemoryLimits
      : args[4] === "rolling" ? (await import("../apps/server/src/test-fixtures/rolling-memory-acceptance.ts")).rollingMemoryLimits
      : args[4] === "recall" ? (await import("../apps/server/src/test-fixtures/recall-model-acceptance.ts")).recallAcceptanceLimits : undefined;
    console.log(JSON.stringify({ status: "starting", provider: config.provider, model: config.model, maximumLogicalModelCalls: recallLimits?.maximumModelCalls ?? (args[4] === "planning" ? 8 : args[4] === "cognitive" ? 3 : 6), maximumDurationMs: recallLimits?.maximumDurationMs ?? (args[4] === "planning" ? 180000 : 120000), ...(recallLimits ? { modelCallTimeoutMs: recallLimits.modelCallTimeoutMs } : {}) }));
    const runner = args[4] === "desktop-stream" ? (await import("../apps/server/src/test-fixtures/desktop-stream-acceptance.ts")).runDesktopStreamAcceptance
      : args[4] === "desktop-memory" ? (await import("../apps/server/src/test-fixtures/desktop-memory-acceptance.ts")).runDesktopMemoryAcceptance
      : args[4] === "rolling" ? (await import("../apps/server/src/test-fixtures/rolling-memory-acceptance.ts")).runRollingMemoryAcceptance
      : args[4] === "planning" ? (await import("../apps/server/src/test-fixtures/planning-model-acceptance.ts")).runPlanningModelAcceptance
      : args[4] === "recall" ? (await import("../apps/server/src/test-fixtures/recall-model-acceptance.ts")).runRecallModelAcceptance
      : args[4] === "cognitive" ? (await import("../apps/server/src/test-fixtures/cognitive-model-acceptance.ts")).runCognitiveModelAcceptance : runFoundationModelAcceptance;
    const report = await runner(service.getProvider(), { mode: "external_model", outputParent: resolve("data/desktop-model-acceptance"),
      modelIdentity: { provider: config.provider, name: config.model } });
    console.log(JSON.stringify({ status: report.status, failure: report.failure, report: join(report.root, "report.json"), calls: report.calls.length }));
    accounts.close(); app.exit(report.status === "passed" ? 0 : 1);
  } catch {
    accounts?.close(); console.error(JSON.stringify({ status: "failed", reason: "desktop_model_setup_failed", detailsRedacted: true })); app.exit(1);
  }
  });
}
