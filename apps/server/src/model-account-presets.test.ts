import { expect, it } from "vitest";
import { defaultModelAccounts } from "./model-account-presets.js";
import { ModelAccountManifestSchema, ModelAccounts } from "./model-accounts.js";
import type { OAuthTokenRecord } from "@traceforge/llm";

it("assembles the explicit Grok compatibility preset without contacting the provider on load", async () => {
  const manifest = ModelAccountManifestSchema.parse(defaultModelAccounts());
  let now = Date.now(); let requests = 0; let record: OAuthTokenRecord | undefined;
  const accounts = new ModelAccounts(manifest, { async read() { return record; }, async write(_id, value) { record = value; }, async remove() { record = undefined; } }, {
    now: () => now, fetch: async (input, init) => {
      requests++; const request = new Request(input, init);
      if (request.url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.x.ai", device_authorization_endpoint: "https://auth.x.ai/device", token_endpoint: "https://auth.x.ai/token" });
      if (request.url.endsWith("/device")) return Response.json({ device_code: "fixture-device", user_code: "fixture-user", verification_uri: "https://accounts.x.ai/activate", expires_in: 600, interval: 1 });
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh" });
    },
  });
  expect((await accounts.list())[0]!.id).toBe("grok-compatible"); expect(requests).toBe(0);
  const login = await accounts.operate("begin", "grok-compatible"); expect(login.state).toBe("pending");
  expect(accounts.authorizationUrl("grok-compatible")).toBe("https://accounts.x.ai/activate");
  now += 1000; expect(await accounts.operate("poll", "grok-compatible")).toEqual({ state: "connected" });
  expect(record!.expiresAt).toBe(now + 3600000);
  await accounts.operate("disconnect", "grok-compatible"); expect(record).toBeUndefined();
});
