// Test-only material, signed by an ephemeral authority inside isolated userData.
// Does not change production trust, grant a Run scope or execute Scenario work.
import {createHash,generateKeyPairSync} from "node:crypto";
import {mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync,realpathSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {parseScenarioPackageDescriptor} from "../packages/scenario-sdk/src/index.ts";
import {scenarioMaterialDigest,scenarioPackageContractDigest,signScenarioPackageReview} from "../apps/server/src/scenario-package-trust.ts";

export async function installAcceptanceFixtures(root){
  const destination=join(root,"package"),config=join(root,"config","scenarios.json");
  if(!existsSync(config)){
    const source=resolve("scenarios/web-blackbox");
    const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(source,"scenario.json"),"utf8")));
    const paths=["scenario.json",...readdirSync(join(source,"runtime")).filter(n=>n.endsWith(".mjs")).map(n=>`runtime/${n}`),...descriptor.resourceManifest.resources.map(r=>r.locator.slice("package://".length))];
    const files=[...new Set(paths)].map(path=>{
      const bytes=readFileSync(join(source,path));mkdirSync(dirname(join(destination,path)),{recursive:true});writeFileSync(join(destination,path),bytes);
      return {path,role:path==="runtime/main.mjs"?"entry":path.startsWith("runtime/")?"dependency":"data",size:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`};
    });
    const manifest={format:"traceforge.scenario-material.v1",package:{id:descriptor.id,version:descriptor.version,schemaRevision:descriptor.schemaRevision},entry:"runtime/main.mjs",files};
    const keys=generateKeyPairSync("ed25519"),keyId="isolated-desktop-review";
    const review=signScenarioPackageReview({format:"traceforge.scenario-review.v1",package:manifest.package,materialDigest:scenarioMaterialDigest(manifest),contractDigest:scenarioPackageContractDigest(descriptor),assemblyRef:"isolated-desktop",keyId,reviewRef:"test-only",issuedAt:"2026-01-01T00:00:00.000Z",expiresAt:"2098-01-01T00:00:00.000Z"},keys.privateKey.export({type:"pkcs8",format:"pem"}).toString());
    writeFileSync(config,JSON.stringify({format:"traceforge.scenario-host.v1",installations:[{root:destination,manifest,review}],authorities:[{keyId,publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),packageIds:[descriptor.id],validFrom:"2025-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"}],launches:[]}),{mode:0o600});
  }
  const configured=JSON.parse(readFileSync(config,"utf8"));
  if(configured.authorities?.[0]?.keyId==="isolated-desktop-review"&&!configured.launches.length){
    const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(destination,"scenario.json"),"utf8")));
    // Electron's executable is not a standalone Node interpreter. The acceptance
    // caller supplies an installed Node runtime; never turn on an unsandboxed fallback.
    const nodePath=process.env.TRACEFORGE_ACCEPTANCE_NODE??(process.versions.electron?undefined:process.execPath);
    if(!nodePath)throw new Error("Set TRACEFORGE_ACCEPTANCE_NODE to an installed standalone Node executable");
    const executable=realpathSync(nodePath);
    configured.launches=[{source:descriptor.runtime.source,executable,arguments:["@config/../package/runtime/main.mjs"],workingDirectory:"../package",
      attribution:{caseId:"foundation",runId:"scenario-services",workId:descriptor.id,workerId:"scenario-host",scopeRef:"host-scope",leaseId:"host-lease",leaseExpiresAt:"2098-01-01T00:00:00.000Z",actionId:"scenario.start",idempotencyKey:`scenario:${descriptor.id}`},
      permissions:{version:1,platform:"darwin",filesystem:{read:[{path:destination,scope:"tree"},{path:executable,scope:"exact"}],write:[],deny:[]},network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:[descriptor.runtime.source]},
      expectedSandboxBackend:"traceforge-macos-native",acceptedResourcePolicy:"sampled_terminate",
      expectedBackendMeasurement:createHash("sha256").update(readFileSync(process.env.TRACEFORGE_MACOS_SANDBOX_HELPER)).digest("hex"),
      resources:{cpuTimeMs:60000,memoryBytes:268435456,maximumProcesses:2,writeBytes:1048576}}];
    writeFileSync(config,JSON.stringify(configured),{mode:0o600});
  }
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
