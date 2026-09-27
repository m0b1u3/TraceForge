// Local acceptance targets only; the desktop loads its one built-in Scenario.
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {createRequire} from "node:module";
import {createServer} from "node:http";

export async function installAcceptanceFixtures(root){
  const pdfPath=join(root,"preview-fixture.pdf");
  if(!existsSync(pdfPath)){
    const {PDFDocument}=createRequire(new URL("../apps/server/package.json",import.meta.url))("pdf-lib");
    const pdf=await PDFDocument.create();
    for(const text of ["First neutral page","Second neutral page"]){const page=pdf.addPage([400,400]);page.drawText(text,{x:40,y:330,size:18});}
    writeFileSync(pdfPath,await pdf.save(),{mode:0o600});
  }
  writeFileSync(join(root,"guidance-fixture.md"),"# Neutral guidance\nKeep original sources attached to notes. This text grants no permissions.\n",{mode:0o600});
}

export async function startAcceptanceMcp(root){
  const server=createServer(async(request,response)=>{
    if(request.method==="GET"&&request.url==="/browser"){
      response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}).end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Neutral browser journey</title><h1>Neutral browser journey</h1><p>Local acceptance fixture. No external targets or credentials.</p><label>Review note <input id="note" autocomplete="off"></label><button id="save">Save note</button><p id="result" role="status">No note saved</p><script>document.getElementById('save').onclick=()=>{document.getElementById('result').textContent='Saved note: '+document.getElementById('note').value;};</script></html>`);return;
    }
    if(request.url==="/reject"){response.writeHead(401).end();return;}
    if(request.method!=="POST"||request.url!=="/mcp"){response.writeHead(404).end();return;}
    let raw="";for await(const chunk of request){raw+=chunk;if(raw.length>65536){response.writeHead(413).end();return;}}
    try{
      const rpc=JSON.parse(raw);let result;
      if(rpc.method==="notifications/initialized"){response.writeHead(202).end();return;}
      if(rpc.method==="initialize")result={protocolVersion:"2025-03-26",serverInfo:{name:"isolated-neutral-fixture",version:"1"},capabilities:{tools:{}}};
      else if(rpc.method==="tools/list")result={tools:[{name:"describe_fixture",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
      else if(rpc.method==="tools/call")result={content:[{type:"text",text:"Neutral test fixture only."}]};
      else{response.writeHead(400).end();return;}
      response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
    }catch{response.writeHead(400).end();}
  });
  const saved=join(root,"mcp-fixture.json");
  const previous=existsSync(saved)?new URL(JSON.parse(readFileSync(saved,"utf8")).endpoint):undefined;
  if(previous&&(previous.protocol!=="http:"||previous.hostname!=="127.0.0.1"||!previous.port))throw new Error("Invalid isolated fixture endpoint");
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(previous?Number(previous.port):0,"127.0.0.1",resolve);});
  const endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
  writeFileSync(join(root,"mcp-fixture.json"),JSON.stringify({endpoint}),{mode:0o600});
  console.log(JSON.stringify({event:"neutral_mcp_fixture",endpoint,browserTarget:`http://127.0.0.1:${server.address().port}/browser`}));
  return ()=>{server.closeAllConnections();server.close();};
}
