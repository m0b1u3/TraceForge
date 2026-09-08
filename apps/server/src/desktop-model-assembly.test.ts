import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { buildServer, foundationHostControl } from "./main.js";
import { ModelAccounts } from "./model-accounts.js";

it("uses the same managed account for formal Server model discovery and inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "traceforge-desktop-model-"));
  const registration = { issuer: "https://issuer.example", clientId: "fixture", scopes: ["inference"], apiBaseUrl: "https://model.example/v1" };
  const requests: Request[] = [];
  const accounts = new ModelAccounts({ version: 1, accounts: [{ id: "fixture", label: "Fixture", provider: "responses", registration }] }, {
    async read() { return { accessToken: "fixture-token", expiresAt: Date.now() + 3600000, binding: JSON.stringify(registration) }; },
    async write() {}, async remove() {},
  }, { fetch: async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    return Response.json(request.url.endsWith("/models") ? { data: [{ id: "fixture-model" }] } : {
      status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}' }] }],
    });
  } });
  const app = await buildServer(":memory:", join(root, "mcp.json"), join(root, "llm.json"), root, undefined, {
    modelAccounts: accounts, llmSecretStore: { load: () => ({ alternativeRoutes: {} }), save() {} },
  });
  try {
    const headers = foundationHostControl(app).management().headers();
    const settings = (await app.inject({ url: "/api/desktop/models", headers })).json();
    expect(settings.accounts[0].status).toBe("connected");
    const config = { provider: "responses", credentialRef: "fixture", authMode: "bearer", model: "fixture-model", baseUrl: registration.apiBaseUrl };
    const payload = { expectedRevision: settings.revision, config };
    expect((await app.inject({ method: "POST", url: "/api/desktop/models/discover", headers, payload })).json().models).toEqual([{ id: "fixture-model" }]);
    expect((await app.inject({ method: "POST", url: "/api/desktop/models/test", headers, payload })).json().ok).toBe(true);
    expect(requests.map(request => request.url)).toEqual([`${registration.apiBaseUrl}/models`, `${registration.apiBaseUrl}/responses`]);
    expect(requests.every(request => request.headers.get("authorization") === "Bearer fixture-token")).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("fixture-token");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  await expect(accounts.list()).rejects.toThrow("closed");
});
