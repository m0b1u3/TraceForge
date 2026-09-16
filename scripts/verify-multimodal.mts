/** Explicit, bounded acceptance. Credentials arrive on no-echo stdin, never argv or disk. */
import {createInterface} from "node:readline";
import {randomInt} from "node:crypto";
import {deflateSync} from "node:zlib";
import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createRequire} from "node:module";
const Fastify=createRequire(new URL("../apps/server/package.json",import.meta.url))("fastify");
import {createProvider} from "../packages/llm/src/index.js";
import {LlmConfigSchema} from "../packages/llm/src/config.js";
import {createDb,getSqliteClient} from "../apps/server/src/db/client.js";
import {registerConversationRoutes} from "../apps/server/src/conversation-routes.js";
import {DesktopReplyService} from "../apps/server/src/desktop-replies.js";

if(process.argv[2]!=="--allow-model-api")throw new Error("Explicit opt-in required");
const input=createInterface({input:process.stdin,terminal:false});
const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),600000),started=Date.now();
let calls=0;const report:any={status:"failed",maxCalls:12,maxDurationMs:600000,checks:{},scope:"synthetic image direct and archived conversation recall; no PDF/audio acceptance"};
let cleanup=async()=>{};
try{
  let line="";for await(const value of input){line=value;break;}input.close();
  if(line.length>16384)throw new Error("input_limit");
  const config=LlmConfigSchema.parse(JSON.parse(line));line="";
  const colors=[{name:"red",rgb:[240,25,25]},{name:"green",rgb:[20,180,30]},{name:"blue",rgb:[25,40,240]}];
  for(let i=2;i>0;i--){const j=randomInt(i+1);[colors[i],colors[j]]=[colors[j],colors[i]];}
  const raw=Buffer.alloc(301*100);for(let y=0;y<100;y++)for(let x=0;x<100;x++)for(let c=0;c<3;c++)raw[y*301+1+x*3+c]=colors[Math.min(2,Math.floor(x/34))].rgb[c];
  const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,body,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(100,0);header.writeUInt32BE(100,4);header[8]=8;header[9]=2;
  const png=Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
  const attachment={kind:"image" as const,name:"reference.png",mediaType:"image/png" as const,data:png.toString("base64")};
  const transport:typeof fetch=async(value,init)=>{const request=new Request(value,init);stop.signal.throwIfAborted();if(request.method==="POST"){if(calls>=12)throw new Error("call_budget");calls++;}const result=await fetch(new Request(request,{signal:AbortSignal.any([stop.signal,request.signal])}));let diagnostic; if(!result.ok){const error=await result.clone().json().catch(()=>null) as any;diagnostic=String(error?.error?.message??"unavailable").replaceAll(config.apiKey??"__none__","[redacted]").slice(0,600);}console.log(JSON.stringify({event:"transport",calls,status:result.status,diagnostic}));return result;};
  const model=createProvider({...config,contextWindowTokens:16384,maxOutputTokens:1024,modelProfile:{model:config.model,baseUrl:config.baseUrl!,protocol:config.provider,source:"operator",imageInput:true}},{fetch:transport});
  const prompt="Read the three vertical colored bands in the image from left to right. Reply only their English color names separated by commas.";
  const direct=await model.streamTools!({system:"Inspect the supplied image accurately.",messages:[{role:"user",content:prompt,attachments:[attachment]}],tools:[]},{signal:stop.signal});
  const correct=(value:string)=>{const found=value.toLowerCase().match(/red|green|blue/g);return JSON.stringify(found)===JSON.stringify(colors.map(c=>c.name));};
  report.checks.directImage=correct(direct.text);if(!report.checks.directImage)throw new Error("image_answer_mismatch");
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  let service:DesktopReplyService|undefined;cleanup=async()=>{service?.close();await app.close();sql.close();};
  const conversation=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Synthetic visual recall"}})).json();
  await app.inject({method:"POST",url:`/api/desktop/conversations/${conversation.id}/messages`,payload:{commandId:"original",text:"Reference image for later inspection.",attachments:[attachment]}});
  for(let n=2;n<=31;n++)sql.prepare("INSERT INTO desktop_conversation_messages VALUES (?,?,?,?,?)").run(conversation.id,`m${n}`,n,n===31?`Use conversation_attachments to find reference.png, then conversation_attachment_read to inspect its original image. ${prompt}`:"Neutral intervening discussion. ".repeat(200),"now");
  service=new DesktopReplyService(sql,()=>model,240000);service.start(conversation.id,"m31");
  let reply:any;while(!stop.signal.aborted){reply=(service.read(conversation.id,0).body as any).replies[0];if(reply&&!["streaming","queued"].includes(reply.state))break;await new Promise(resolve=>setTimeout(resolve,100));}
  const tools=sql.prepare("SELECT tool FROM desktop_reply_reads ORDER BY ordinal").all() as {tool:string}[];
  report.checks.archivedImage=reply?.state==="completed"&&correct(reply.text);
  report.checks.contextTruncated=reply?.contextTruncated===true;
  report.checks.usedOriginalRead=tools.some(row=>row.tool==="conversation_attachment_read");
  report.replyState=reply?.state;report.replyError=reply?.error;
  report.status=Object.values(report.checks).every(Boolean)?"passed":"failed";
}catch{report.failure="acceptance_failed_details_redacted";}finally{
  await cleanup();input.close();clearTimeout(timer);stop.abort();report.calls=calls;report.elapsedMs=Date.now()-started;
  await mkdir("data/desktop-model-acceptance",{recursive:true});const root=await mkdtemp("data/desktop-model-acceptance/multimodal-");await writeFile(join(root,"report.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({...report,report:join(root,"report.json")}));process.exitCode=report.status==="passed"?0:1;
}
