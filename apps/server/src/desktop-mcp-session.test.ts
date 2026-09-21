import {expect,it} from "vitest";
import {createServer} from "node:http";
import {DesktopMcpSession} from "./desktop-mcp-session.js";
import {McpConnectionSchema} from "@traceforge/shared/desktop-mcp";
import type {BrokeredHttpTransport} from "@traceforge/execution-node";
const connection=McpConnectionSchema.parse({id:"first",name:"First",transport:"streamable-http",endpoint:"https://mcp.example/mcp",package:{id:"neutral",version:"1",schemaRevision:1},authorizationAction:"read",capability:"read"});
it.each([false,true])("uses pinned HTTP with explicit IP or domain address binding (%s) and stops open SSE",async(domain)=>{
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const message=JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.write(`data: ${JSON.stringify({jsonrpc:"2.0",id:message.id,result:{observed:true}})}\n\n`);
    // Deliberately keep the stream open: matching RPC, not remote EOF, terminates the read.
  });
  await new Promise<void>(resolve=>server.listen(0,"::",resolve));
  try{
    const client=new DesktopMcpSession({...connection,endpoint:`http://${domain?"localhost":"127.0.0.1"}:${(server.address() as {port:number}).port}/mcp`,...(domain?{destinationAddresses:["127.0.0.1","::1"]}:{})},undefined,
      {caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:new Date(Date.now()+60000).toISOString(),actionId:"test",idempotencyKey:"test"},()=>{});
    expect(await client.rpc("tools/list")).toEqual({observed:true});
    expect(["127.0.0.1","::1"]).toContain(client.receipts[0]?.destination?.address);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
function session(transport:BrokeredHttpTransport,signal?:AbortSignal){return new DesktopMcpSession(connection,"private-token",{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:new Date(Date.now()+60000).toISOString(),actionId:"test",idempotencyKey:"test"},()=>{},transport,signal);}
it("redacts echoed credentials and rejects reverse RPC",async()=>{
  const response=(body:unknown)=>({status:200,headers:[{name:"content-type",value:"application/json"}],body:Buffer.from(JSON.stringify(body)),bodyTruncated:false});
  const client=session(async request=>response({jsonrpc:"2.0",id:JSON.parse(request.body!.toString()).id,result:{text:"private-token"}}));
  expect(await client.rpc("tools/call")).toEqual({text:"[REDACTED]"});
  expect(JSON.stringify(client.receipts)).not.toContain("private-token");
  await expect(session(async()=>response({jsonrpc:"2.0",id:"remote",method:"sampling/createMessage"})).rpc("tools/call")).rejects.toThrow("reverse request");
});
it("does not retry redirects and cancels before transport",async()=>{
  let calls=0;
  const transport:BrokeredHttpTransport=async()=>{calls++;return {status:302,headers:[{name:"location",value:"https://other.example/"}],body:Buffer.alloc(0),bodyTruncated:false};};
  await expect(session(transport).rpc("tools/list")).rejects.toThrow();expect(calls).toBe(1);
  const controller=new AbortController();controller.abort();
  await expect(session(transport,controller.signal).rpc("tools/list")).rejects.toThrow();expect(calls).toBe(1);
});
it("rejects broad or traversal stdio filesystem grants",()=>{
  for(const path of ["/","//","/tmp/..","relative","/tmp/\0"]){expect(McpConnectionSchema.safeParse({...connection,transport:"stdio",endpoint:"",executable:"/usr/bin/tool",workingDirectory:"/tmp/work",writePaths:[path]}).success).toBe(false);}
});
