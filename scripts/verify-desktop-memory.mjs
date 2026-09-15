// Native Electron journey with a synthetic local model. Never opens user data.
import { app, BrowserWindow, dialog } from "electron";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { register } from "../apps/server/dist/development-loader.js";
register();
const restoring = process.argv[2] === "--restore";
const root = restoring ? resolve(process.argv[3] ?? "") : mkdtempSync(join(tmpdir(), "traceforge-memory-desktop-"));
if (restoring && !root.startsWith(resolve(tmpdir()) + "/traceforge-memory-desktop-")) throw new Error("Invalid isolated restore path");
app.setPath("userData", root);
let hold = !restoring, hanging = false, calls = 0;
const server = createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
  let raw = ""; for await (const part of request) { raw += part; if (raw.length > 1048576) { response.writeHead(413).end(); return; } }
  calls++; const body = JSON.parse(raw);
  if (!body.stream) {
    if (hold) return; // Cancellation must not wait for this non-cooperating fixture.
    const input = JSON.parse(body.messages.find(message => message.role === "user").content);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ entries: input.entries.map(entry => ({ id: entry.id, text: "Historical detail remains available in the saved original conversation." })) }) }, finish_reason: "stop" }] }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (hanging) { frame({ content: "Durable partial reply" }); return; }
  if (body.messages.at(-1).role !== "tool") {
    frame({ tool_calls: [{ index: 0, id: "native-read", type: "function", function: { name: "conversation_read", arguments: '{"id":"early"}' } }] });
    frame({}, "tool_calls");
  } else {
    if (!body.messages.at(-1).content.includes("native-reference-731")) throw new Error("Original detail missing");
    frame({ content: "Reference recovered: native-reference-731" }); frame({}, "stop");
  }
  response.end("data: [DONE]\n\n");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
app.on("will-quit", () => { server.closeAllConnections(); server.close(); });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
const deadline = setTimeout(() => { console.error("NATIVE_MEMORY_TIMEOUT"); app.exit(1); }, 120000);
await import("../apps/desktop/dist/main.js");
async function until(read, check, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}
void app.whenReady().then(async () => { try {
  const window = await until(async () => BrowserWindow.getAllWindows()[0], value => value && !value.webContents.isLoading() && value.webContents.getURL(), "Window unavailable", 600);
  const js = source => window.webContents.executeJavaScript(source);
  await until(() => js("!!window.traceforgeDesktop?.conversations"), Boolean, "Bridge unavailable");
  const request = (path, body) => js(`window.traceforgeDesktop.conversations.request(${JSON.stringify({ path, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })})`);
  let id;
  if (restoring) {
    id = JSON.parse(readFileSync(join(root, "memory-check.json"), "utf8")).id;
    const rows = (await request(`/api/desktop/conversations/${id}/replies?after=0`)).body.replies;
    if (!rows.some(row => row.messageCommandId === "answer" && row.state === "completed") || !rows.some(row => row.messageCommandId === "interrupted" && row.state === "interrupted" && row.text === "Durable partial reply")) throw new Error("Restart lost saved replies");
    await request(`/api/desktop/conversations/${id}/replies/interrupted`, {});
    if (calls !== 0) throw new Error("Restart replayed inference");
    await until(() => js("document.body.innerText"), text => text.includes("Native memory journey") && text.includes("Durable partial reply"), "View location not restored across origin");
    if (!(await js("window.traceforgeDesktop.localState.getItem('traceforge.desktop.session-drafts.v1')")).includes("Unsent draft survived")) throw new Error("Draft lost on restart");
    console.log("NATIVE_MEMORY_FULL_PROCESS_RESTORE_OK");
  } else {
    id = (await request("/api/desktop/conversations", { commandId: "create", title: "Native memory journey" })).body.id;
    await request(`/api/desktop/conversations/${id}/messages`, { commandId: "early", text: "Original reference: native-reference-731" });
    for (let i = 0; i < 12; i++) await request(`/api/desktop/conversations/${id}/messages`, { commandId: `history${i}`, text: "Neutral history record. ".repeat(140) });
    await js(`window.traceforgeDesktop.localState.setItem('traceforge.desktop.last-conversation.v1',${JSON.stringify(id)})`);
    window.webContents.reload(); await until(() => js("document.body.innerText"), text => text.includes("Native memory journey") && text.includes("Neutral history record"), "Conversation not restored");
  }
  const saveModel = await js(`(async()=>{const bridge=window.traceforgeDesktop.modelSettings;const current=await bridge.request({operation:'load'});return bridge.request({operation:'save',payload:{expectedRevision:current.body.revision,config:{provider:'openai',model:'native-fixture',apiKey:'synthetic-only',baseUrl:${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)},jsonMode:'json_object',contextWindowTokens:16000,maxOutputTokens:2048}}});})()`);
  if (saveModel.status !== 200) throw new Error("Fixture model setup failed");
  const readReply = async message => (await request(`/api/desktop/conversations/${id}/replies?after=0`)).body.replies.find(row => row.messageCommandId === message);
  const screenshots = resolve("output/playwright"); mkdirSync(screenshots, { recursive: true });
  if (!restoring) {
    await request(`/api/desktop/conversations/${id}/replies/history11`, {});
    await until(() => js("document.body.innerText"), text => text.includes("正在整理上下文"), "Compaction not visible");
    await js("document.querySelector('.conversation-reply')?.scrollIntoView({block:'center'})");
    writeFileSync(join(screenshots, "memory-compacting-desktop.png"), (await window.webContents.capturePage()).toPNG());
    window.setSize(1024, 760); await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(screenshots, "memory-compacting-compact.png"), (await window.webContents.capturePage()).toPNG());
    await js("[...document.querySelectorAll('button')].find(button=>button.textContent==='停止回复').click()");
    await until(() => readReply("history11"), row => row?.state === "cancelled", "Compaction stop failed");
    hold = false;
  }
  const message = restoring ? "continued" : "answer";
  await request(`/api/desktop/conversations/${id}/messages`, { commandId: message, text: "Read my saved original reference before replying." });
  await request(`/api/desktop/conversations/${id}/replies/${message}`, {});
  const answer = await until(() => readReply(message), row => row?.state === "completed", "Readback did not complete");
  if (!answer.recallCount || !answer.text.includes("native-reference-731")) throw new Error("Native readback missing");
  console.log("NATIVE_MEMORY_SUMMARY_READBACK_OK");
  if (!restoring) {
    hanging = true;
    await request(`/api/desktop/conversations/${id}/messages`, { commandId: "interrupted", text: "A new unfinished reply." });
    await request(`/api/desktop/conversations/${id}/replies/interrupted`, {});
    await until(() => readReply("interrupted"), row => row?.text === "Durable partial reply", "Partial not persisted");
    await js(`window.traceforgeDesktop.localState.setItem('traceforge.desktop.session-drafts.v1',${JSON.stringify(JSON.stringify({ [id]: "Unsent draft survived" }))})`);
    writeFileSync(join(root, "memory-check.json"), JSON.stringify({ id }), { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: "passed", stage: restoring ? "restored" : "initial", root, modelCalls: calls }));
  clearTimeout(deadline); app.quit();
} catch (error) { console.error(error); app.exit(1); } });
