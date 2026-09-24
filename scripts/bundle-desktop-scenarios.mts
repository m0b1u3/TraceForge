import {createHash,generateKeyPairSync} from "node:crypto";
import {copyFileSync,chmodSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseScenarioPackageDescriptor} from "../packages/scenario-sdk/src/index.js";
import {scenarioMaterialDigest,scenarioPackageContractDigest,signScenarioPackageReview,type ScenarioMaterialManifest} from "../apps/server/src/scenario-package-trust.js";

// Build-time only. The private key is never written or shipped. Trust derives
// from the application distribution, not downloaded/user-selected package paths.
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),sourceRoot=join(root,"scenarios"),output=join(root,"apps/desktop/bundled-scenarios");
const catalog=JSON.parse(readFileSync(join(sourceRoot,"builtin.json"),"utf8")) as {packages:string[]};
mkdirSync(output,{recursive:true});
const node=realpathSync(process.execPath),nodeBytes=readFileSync(node),hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const nodeName=process.platform==="win32"?"node.exe":"node";
copyFileSync(node,join(output,nodeName));chmodSync(join(output,nodeName),0o755);
const installations=[];
for(const name of catalog.packages){
  if(!/^[a-z0-9-]+$/.test(name))throw new Error("Invalid built-in Scenario path");
  const source=join(sourceRoot,name),descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(source,"scenario.json"),"utf8")));
  const entry=descriptor.runtime!.entrypoint.slice("package://".length);
  const paths=["scenario.json",...readdirSync(join(source,dirname(entry))).filter(p=>p.endsWith(".mjs")).sort().map(p=>`${dirname(entry)}/${p}`),...(descriptor.resourceManifest?.resources??[]).filter(r=>!r.context?.external).map(r=>r.locator.slice("package://".length))];
  const files:ScenarioMaterialManifest["files"]=paths.map(path=>{
    if(path.split("/").some(p=>p===".."||!p))throw new Error("Invalid bundled material path");
    const bytes=readFileSync(join(source,path));return {path,role:path===entry?"entry":path.endsWith(".mjs")?"dependency":"data",size:bytes.length,digest:`sha256:${hash(bytes)}`};
  });
  const manifest:ScenarioMaterialManifest={format:"traceforge.scenario-material.v1",package:{id:descriptor.id,version:descriptor.version,schemaRevision:descriptor.schemaRevision},entry,files};
  const materialDigest=scenarioMaterialDigest(manifest),directory=`${name}-${descriptor.version}-${materialDigest.slice(7,19)}`;
  for(const file of files){const destination=join(output,directory,file.path);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(source,file.path),destination);}
  const keys=generateKeyPairSync("ed25519"),keyId=`builtin-${name}`,issuedAt="2026-01-01T00:00:00.000Z",expiresAt="2099-01-01T00:00:00.000Z";
  const review=signScenarioPackageReview({format:"traceforge.scenario-review.v1",package:manifest.package,materialDigest,contractDigest:scenarioPackageContractDigest(descriptor),assemblyRef:"desktop-builtin",keyId,reviewRef:materialDigest,issuedAt,expiresAt},keys.privateKey.export({type:"pkcs8",format:"pem"}).toString());
  installations.push({directory,manifest,review,authority:{keyId,publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),packageIds:[descriptor.id],validFrom:issuedAt,validUntil:expiresAt}});
}
writeFileSync(join(output,"catalog.json"),JSON.stringify({version:1,node:{file:nodeName,sha256:hash(nodeBytes)},installations},null,2));
console.log(`Bundled ${installations.length} built-in Scenario(s) and standalone Node runtime`);
