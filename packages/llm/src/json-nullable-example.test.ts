import { expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai-provider.js";

it("uses null rather than a misleading empty string for nullable JSON extraction examples", async () => {
  let body: any;
  const provider = new OpenAICompatibleProvider({ model: "fixture", apiKey: "test", jsonMode: "json_object", fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "result", choices: [{ message: { role: "assistant", content: '{"detail":null}' }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  } });
  expect(await provider.extractJson({ system: "Use null when absent", user: "No detail", schema: { type: "object", properties: { detail: { type: ["string", "null"] } } } })).toEqual({ detail: null });
  expect(body.messages[0].content).toContain('JSON 输出示例：{"detail":null}');
});
