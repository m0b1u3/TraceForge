import { describe, expect, it } from "vitest";
import { createConversationBridge, validateConversationRequest } from "./conversation-bridge.js";

const origin = "http://127.0.0.1:41234";
const sender = { webContentsId: 7, mainFrame: true, url: `${origin}/` };
const input = { path: "/api/desktop/conversations", method: "GET" };
it("accepts opaque file references but never exposes the host import endpoint or file paths",()=>{
  const path="/api/desktop/conversations/first/messages";
  const attachment={kind:"reference",id:"40f721bd-7662-4cb0-8f7d-27e99d4cce0e",name:"book.pdf"};
  const body={commandId:"message",text:"Read",attachments:[attachment]};
  expect(validateConversationRequest({path,method:"POST",body:JSON.stringify(body)}).path).toBe(path);
  expect(()=>validateConversationRequest({path:"/api/desktop/attachment-import",method:"POST",body:JSON.stringify({name:"book.pdf",data:"AAAA"})})).toThrow();
  expect(()=>validateConversationRequest({path,method:"POST",body:JSON.stringify({...body,attachments:[{...attachment,path:"/private/file.pdf"}]})})).toThrow();
});
it("allows only a narrow live approval preference operation", () => {
  const path = "/api/desktop/approval-preference";
  expect(validateConversationRequest({ path, method: "GET" })).toEqual({ path, method: "GET" });
  expect(validateConversationRequest({ path, method: "POST", body: JSON.stringify({ expectedRevision: 0, routineApprovalRequired: false }) }).method).toBe("POST");
  expect(() => validateConversationRequest({ path, method: "POST", body: JSON.stringify({ expectedRevision: 0, routineApprovalRequired: false, bypassSandbox: true }) })).toThrow();
});
describe("narrow desktop conversation bridge", () => {
  it("allows only explicitly confirmed bounded permission changes on a fixed Run route",()=>{
    const path="/api/desktop/conversations/first/execution/run/permissions";
    const body={commandId:"change",runId:"run",expectedRevision:1,expectedScopeRevision:1,scope:{autonomous:true},reason:"Reviewed"};
    expect(validateConversationRequest({path,method:"GET"})).toEqual({path,method:"GET"});
    expect(()=>validateConversationRequest({path,method:"POST",body:JSON.stringify(body)})).toThrow();
    expect(validateConversationRequest({path,method:"POST",body:JSON.stringify({...body,confirmed:true})}).method).toBe("POST");
    expect(()=>validateConversationRequest({path,method:"POST",body:JSON.stringify({...body,confirmed:true,execute:"shell"})})).toThrow();
  });
  it("permits bounded pause and explicitly confirmed resume without policy overrides",()=>{
    const body={commandId:"first",runId:"run",expectedRevision:1};
    const path="/api/desktop/conversations/first/execution/resume";
    expect(()=>validateConversationRequest({path,method:"POST",body:JSON.stringify(body)})).toThrow();
    expect(validateConversationRequest({path,method:"POST",body:JSON.stringify({...body,confirmed:true})}).path).toBe(path);
    expect(()=>validateConversationRequest({path,method:"POST",body:JSON.stringify({...body,confirmed:true,scope:"*"})})).toThrow();
    expect(validateConversationRequest({path:path.replace("resume","pause"),method:"POST",body:JSON.stringify(body)}).method).toBe("POST");
  });
  it("allows only bounded declarative configuration edits, never launch code or authority overrides", () => {
    const path = "/api/desktop/configuration", body = { package: { id: "neutral", version: "1", schemaRevision: 1 }, expectedRevision: 0,
      resources: [{ id: "guide", enabled: true, content: "User guidance" }], mcp: [] };
    expect(validateConversationRequest({ path, method: "GET" })).toEqual({ path, method: "GET" });
    expect(validateConversationRequest({ path, method: "POST", body: JSON.stringify(body) }).path).toBe(path);
    for (const extra of [{ shell: "execute" }, { scope: "*" }, { expectedRevision: -1 }])
      expect(() => validateConversationRequest({ path, method: "POST", body: JSON.stringify({ ...body, ...extra }) })).toThrow();
    expect(() => validateConversationRequest({ path, method: "GET", body: "{}" })).toThrow();
  });
  it("validates operator commands and forbids arbitrary action input", () => {
    const common = { commandId: "command", runId: "run", workId: "work", expectedRevision: 3 };
    const path = "/api/desktop/conversations/first/execution/approval";
    const body = { ...common, approvalId: "approval:work:call", approved: true, reason: "Reviewed", reviewedInputRef: "checkpoint://digest" };
    expect(validateConversationRequest({ path, method: "POST", body: JSON.stringify(body) }).path).toBe(path);
    expect(validateConversationRequest({ path: path.replace("approval", "input"), method: "POST", body: JSON.stringify({ ...common, instruction: "Additional context" }) }).method).toBe("POST");
    for (const change of [{ reason: "" }, { actionKey: "different" }, { approved: "yes" }, { expectedRevision: -1 }])
      expect(() => validateConversationRequest({ path, method: "POST", body: JSON.stringify({ ...body, ...change }) })).toThrow();
    expect(() => validateConversationRequest({ path, method: "GET" })).toThrow();
  });
  it("allows bounded progress reads only", () => {
    const path = "/api/desktop/conversations/first/execution/run/events?after=0";
    expect(validateConversationRequest({ path, method: "GET" }).path).toBe(path);
    for (const value of [{ path, method: "POST" }, { path, method: "GET", body: "{}" }, { path: path + "&limit=999", method: "GET" }, { path: path.replace("after=0", "after=-1"), method: "GET" }])
      expect(() => validateConversationRequest(value)).toThrow();
  });
  it("accepts only strict bounded evidence reads with no host identity override", () => {
    const request = { path: "/api/desktop/conversations/first/evidence/read", method: "POST", body: JSON.stringify({ runId: "run", ref: "ref", offset: 0 }) };
    expect(validateConversationRequest(request)).toEqual(request);
    for (const change of [{ method: "GET" }, { body: JSON.stringify({ runId: "run", ref: "ref", offset: -1 }) },
      { body: JSON.stringify({ runId: "run", ref: "ref", offset: 0, caseId: "other" }) }, { path: `${request.path}/other` }])
      expect(() => validateConversationRequest({ ...request, ...change })).toThrow();
  });
  it("allows only bounded application execution commands, not raw Scenario APIs", () => {
    const path = "/api/desktop/conversations/first/execution";
    const command = { commandId: "command-first", messageCommandId: "message-first", scopeRef: "scope-first", scenarioKind: "review", definitionVersion: 1 };
    expect(validateConversationRequest({ path, method: "POST", body: JSON.stringify(command) }).path).toBe(path);
    expect(validateConversationRequest({ path, method: "GET" }).path).toBe(path);
    for (const request of [
      { path: "/api/scenarios/runs", method: "POST", body: JSON.stringify(command) },
      { path, method: "POST", body: JSON.stringify({ ...command, caseId: "other" }) },
      { path: `${path}/authorize`, method: "GET" },
      { path: `${path}/anything`, method: "GET" },
    ]) expect(() => validateConversationRequest(request)).toThrow();
  });
  it("accepts only the trusted main frame and forwards no credentials from the renderer", async () => {
    const calls: unknown[] = [];
    const bridge = createConversationBridge({ webContentsId: 7, origin, host: { request: async value => { calls.push(value); return { status: 200, body: {} }; } } });
    expect(await bridge.request(sender, input)).toEqual({ status: 200, body: {} });
    expect(calls).toEqual([input]);
    for (const changed of [{ ...sender, mainFrame: false }, { ...sender, webContentsId: 8 }, { ...sender, url: `${origin}.evil.test/` }, { ...sender, url: "http://127.0.0.1:41235/" }, { ...sender, url: `${origin}/other` }]) await expect(bridge.request(changed, input)).rejects.toThrow("Untrusted");
    bridge.close(); await expect(bridge.request(sender, input)).rejects.toThrow("Untrusted");
  });
  it.each(["https://example.test/", "/api/config/llm", "/api/desktop/conversations/../cases", "/api/desktop/conversations/a/messages?after=0&limit=100&extra=1", "/api/desktop/conversations/a%2fb"])("rejects non-allowlisted path %s", path => {
    expect(() => validateConversationRequest({ ...input, path })).toThrow();
  });
  it("rejects header injection, method expansion and extra write fields", () => {
    expect(() => validateConversationRequest({ ...input, headers: { authorization: "token" } })).toThrow();
    expect(() => validateConversationRequest({ ...input, method: "DELETE" })).toThrow();
    expect(() => validateConversationRequest({ ...input, method: "POST", body: JSON.stringify({ commandId: "c", title: "text", runId: "r" }) })).toThrow();
    expect(validateConversationRequest({ ...input, method: "POST", body: JSON.stringify({ commandId: "c", title: "text" }) }).method).toBe("POST");
  });
});
