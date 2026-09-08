// Run with Electron after the desktop build and prepare:runtime. No existing
// user data, model account, Scenario installation or external target is used.
import { app, BrowserWindow, dialog } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { register } from "../apps/server/dist/development-loader.js";
register();
app.setPath("userData", mkdtempSync(join(tmpdir(), "traceforge-launch-check-")));
// Protocol fixture only: no real model account, outbound target or user data.
let modelCalls = 0;
const streams = new Set();
const upstream = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  modelCalls++;
  request.resume();
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Neutral assistant " }, finish_reason: null }] })}\n\n`);
  streams.add(response); response.on("close", () => streams.delete(response));
});
await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
const modelBase = `http://127.0.0.1:${upstream.address().port}/v1`;
app.on("before-quit", () => { upstream.closeAllConnections(); upstream.close(); });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
const deadline = setTimeout(() => { console.error("Desktop launch timed out"); app.exit(1); }, 20000);
await import("../apps/desktop/dist/main.js");
const poll = setInterval(async () => {
  let window = BrowserWindow.getAllWindows()[0];
  if (!window || window.webContents.isLoading()) return;
  clearInterval(poll);
  try {
    const state = await window.webContents.executeJavaScript("({text:document.body.innerText, bridge:window.traceforgeDesktop?.conversations?.protocolVersion})");
    if (state.bridge !== 1 || !state.text.includes("这次想调查什么？")) throw new Error("Formal renderer or preload unavailable");
    const denied=await window.webContents.executeJavaScript(`(async()=>{
      const read=await fetch('/api/cases');
      const write=await fetch('/api/cases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'must-not-create'})});
      const ws=await new Promise(resolve=>{const socket=new WebSocket(location.origin.replace('http:','ws:')+'/ws');const timer=setTimeout(()=>{socket.close();resolve(false);},1500);socket.onopen=()=>{clearTimeout(timer);socket.close();resolve(true);};socket.onerror=()=>{clearTimeout(timer);resolve(false);};});
      return {read:read.status,write:write.status,ws};
    })()`);
    if(denied.read!==401||denied.write!==401||denied.ws)throw new Error("Renderer acquired ambient management authority");
    console.log("DESKTOP_RENDERER_AUTHORITY_FENCE_OK");
    const persisted = await window.webContents.executeJavaScript(`(async()=>{
      const bridge=window.traceforgeDesktop.conversations;
      const created=await bridge.request({path:"/api/desktop/conversations",method:"POST",body:JSON.stringify({commandId:"desktop-smoke-create",title:"Neutral desktop verification"})});
      if(created.status!==200&&created.status!==201)throw new Error("Create failed");
      const id=created.body.id;
      const input={path:"/api/desktop/conversations/"+id+"/messages",method:"POST",body:JSON.stringify({commandId:"desktop-smoke-message",text:"Neutral investigation intent; no execution authorized."})};
      const first=await bridge.request(input),repeated=await bridge.request(input);
      if(first.body.sequence!==1||repeated.body.sequence!==1)throw new Error("Message reconciliation failed");
      return id;
    })()`);
    const modelSaved = await window.webContents.executeJavaScript(`(async()=>{
      const models=window.traceforgeDesktop.modelSettings;
      const current=await models.request({operation:"load"});
      return (await models.request({operation:"save",payload:{expectedRevision:current.body.revision,config:{provider:"openai",model:"neutral-fixture",baseUrl:${JSON.stringify(modelBase)},apiKey:"synthetic-not-a-credential",jsonMode:"json_object"}}})).status;
    })()`);
    if(modelSaved!==200)throw new Error("Synthetic model configuration failed");
    const replyPath=`/api/desktop/conversations/${persisted}/replies/desktop-smoke-message`;
    const postReply = path => window.webContents.executeJavaScript(`window.traceforgeDesktop.conversations.request({path:${JSON.stringify(path)},method:"POST",body:"{}"})`);
    const readReplies = () => window.webContents.executeJavaScript(`window.traceforgeDesktop.conversations.request({path:${JSON.stringify(`/api/desktop/conversations/${persisted}/replies?after=0`)},method:"GET"})`);
    await postReply(replyPath);await postReply(replyPath);
    const waitReply = async (messageId,state) => {
      for(let attempt=0;attempt<60;attempt++){
        const page=await readReplies(),row=page.body?.replies?.find(item=>item.messageCommandId===messageId);
        if(page.status===200&&row?.state===state&&row.text)return row;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error("Desktop reply state not persisted");
    };
    const partial=await waitReply("desktop-smoke-message","streaming");
    const stopped=await postReply(`${replyPath}/cancel`);
    if(stopped.body.state!=="cancelled"||stopped.body.text!==partial.text||modelCalls!==1)throw new Error("Desktop streaming cancellation/reconciliation failed");
    // Wait for the local adapter to acknowledge cancellation before the next turn.
    await new Promise(resolve=>setTimeout(resolve,100));
    await window.webContents.executeJavaScript(`window.traceforgeDesktop.conversations.request({path:${JSON.stringify(`/api/desktop/conversations/${persisted}/messages`)},method:"POST",body:JSON.stringify({commandId:"desktop-smoke-second",text:"Continue the neutral text-only discussion."})})`);
    await postReply(replyPath.replace("desktop-smoke-message","desktop-smoke-second"));
    await waitReply("desktop-smoke-second","streaming");
    for(const response of streams){
      response.write(`data: ${JSON.stringify({choices:[{delta:{content:"completed."},finish_reason:null}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
    }
    const completed=await waitReply("desktop-smoke-second","completed");
    if(completed.text!=="Neutral assistant completed."||modelCalls!==2)throw new Error("Desktop stream completion failed");
    console.log("DESKTOP_NATIVE_REPLY_STREAM_OK");
    if (process.platform === "darwin") {
      const identity = window.webContents.id;
      window.close();
      if (window.isDestroyed() || window.isVisible()) throw new Error("Closing must preserve and hide the macOS window");
      app.emit("activate");
      if (!window.isVisible() || window.webContents.id !== identity) throw new Error("Dock activation did not restore the original window");
      const protocol = await window.webContents.executeJavaScript("window.traceforgeDesktop?.conversations?.protocolVersion");
      if (protocol !== 1) throw new Error("Desktop bridge lost after window restoration");
      console.log("MACOS_WINDOW_RESTORE_OK");
    }
    const history = await window.webContents.executeJavaScript(`window.traceforgeDesktop.conversations.request({path:${JSON.stringify(`/api/desktop/conversations/${persisted}/messages?after=0&limit=100`)},method:"GET"})`);
    if(history.status!==200||history.body.messages.length!==2)throw new Error("Saved conversation unavailable after restoration");
    const restoredReplies=await readReplies();
    if(restoredReplies.body.replies.length!==2||modelCalls!==2)throw new Error("Reply recovery replayed model inference");
    const origin=new URL(window.webContents.getURL()).origin,identity=window.webContents.id;
    window.destroy();app.emit("activate");app.emit("activate");
    for(let attempt=0;attempt<100;attempt++){
      const replacement=BrowserWindow.getAllWindows()[0];
      if(replacement&&!replacement.webContents.isLoading()&&replacement.webContents.getURL()) { window=replacement;break; }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(window.isDestroyed()||window.webContents.id===identity||new URL(window.webContents.getURL()).origin!==origin||BrowserWindow.getAllWindows().length!==1)throw new Error("Window recreation restarted or duplicated the host");
    const rebuilt=await readReplies();if(rebuilt.status!==200||rebuilt.body.replies.length!==2)throw new Error("Recreated window lost IPC/history");
    const burst=await window.webContents.executeJavaScript(`Promise.all(Array.from({length:20},(_,i)=>window.traceforgeDesktop.conversations.request({path:${JSON.stringify(`/api/desktop/conversations/${persisted}/messages?after=`)}+i+'&limit=100',method:'GET'})).concat([window.traceforgeDesktop.conversations.request({path:${JSON.stringify(`${replyPath}/cancel`)},method:'POST',body:'{}'})]))`);
    if(burst.some(item=>item.status!==200))throw new Error("Desktop request burst failed");
    console.log("DESKTOP_WINDOW_RECREATE_AND_QUEUE_OK");
    console.log("DESKTOP_CONVERSATION_RECONCILIATION_OK");
    console.log("FORMAL_DESKTOP_SMOKE_OK"); clearTimeout(deadline); app.quit();
  } catch (error) { console.error(error); app.exit(1); }
}, 250);
