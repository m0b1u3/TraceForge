import {it,expect} from "vitest";
import {connect} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildServer} from "./main.js";
import {foundationHostControl} from "./foundation-host-control.js";

it.each([false,true])("unfinished local requests: closeActiveConnections=%s",async(closeActiveConnections)=>{
  const root=mkdtempSync(join(tmpdir(),"traceforge-shutdown-"));
  const app=await buildServer(":memory:",join(root,"mcp.json"),join(root,"llm.json"),root,undefined,{closeActiveConnections});
  let socket:ReturnType<typeof connect>|undefined;
  try{
    let entered!:()=>void;const receiving=new Promise<void>(resolve=>{entered=resolve;});
    app.addHook("onRequest",async()=>{entered();});
    await app.listen({host:"127.0.0.1",port:0});
    socket=connect((app.server.address() as {port:number}).port,"127.0.0.1");
    socket.on("error",()=>{});
    const headers=Object.entries(foundationHostControl(app).management().headers()).map(([k,v])=>`${k}: ${v}`).join("\r\n");
    socket.write(`POST /api/desktop/conversations HTTP/1.1\r\nHost: localhost\r\n${headers}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    await receiving;
    let closed=false;const closing=app.close().then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,200));
    expect(closed).toBe(closeActiveConnections);socket.destroy();await closing;
  }finally{socket?.destroy();await app.close();rmSync(root,{recursive:true,force:true});}
},10000);
