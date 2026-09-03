import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../packages/orchestration-core/src/index.js";
import { parseScenarioPackageDescriptor } from "../packages/scenario-sdk/src/index.js";
import { scenarioMaterialDigest, scenarioPackageContractDigest, signScenarioPackageReview, type ScenarioMaterialManifest } from "../apps/server/src/scenario-package-trust.js";

const flags=parseFlags(process.argv.slice(2));
const source=realDirectory(flags.source,"--source"),output=absolute(flags.output,"--output"),keyPath=realFile(flags["private-key"],"--private-key");
if(existsSync(output))throw new Error("Scenario package output must not already exist");
const descriptorBytes=readFileSync(join(source,"scenario.json"));
const descriptor=parseScenarioPackageDescriptor(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(descriptorBytes)));
const entry=descriptor.runtime!.entrypoint.slice("package://".length);
const paths=["scenario.json",entry,...(descriptor.resourceManifest?.resources??[]).filter(item=>!item.context?.external)
  .map(item=>item.locator.slice("package://".length))];
if(new Set(paths).size!==paths.length||paths.length>128)throw new Error("Scenario package material list is invalid");
const files:ScenarioMaterialManifest["files"]=paths.map(path=>{
  const input=join(source,path),bytes=readFileSync(input);if(bytes.length>1024*1024)throw new Error(`Scenario material exceeds file limit: ${path}`);
  return {path,role:path===entry?"entry":path==="scenario.json"||descriptor.resourceManifest?.resources.some(item=>item.locator===`package://${path}`)?"data":"dependency",
    size:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`};
});
if(files.reduce((total,file)=>total+file.size,0)>4*1024*1024)throw new Error("Scenario package exceeds aggregate byte limit");
for(const file of files){mkdirSync(dirname(join(output,file.path)),{recursive:true});copyFileSync(join(source,file.path),join(output,file.path));}
const material:ScenarioMaterialManifest={format:"traceforge.scenario-material.v1",package:{id:descriptor.id,version:descriptor.version,schemaRevision:descriptor.schemaRevision},entry,files};
const privateKeyPem=readFileSync(keyPath,"utf8"),privateKey=createPrivateKey(privateKeyPem);
if(privateKey.asymmetricKeyType!=="ed25519")throw new Error("Scenario review signing requires an Ed25519 private key");
const issuedAt=new Date().toISOString(),review=signScenarioPackageReview({format:"traceforge.scenario-review.v1",package:material.package,
  materialDigest:scenarioMaterialDigest(material),contractDigest:scenarioPackageContractDigest(descriptor),assemblyRef:"data-only-scenario-descriptor",
  keyId:required(flags["key-id"],"--key-id"),reviewRef:required(flags["review-ref"],"--review-ref"),issuedAt,
  expiresAt:iso(flags["expires-at"],"--expires-at")},privateKeyPem);
const sidecar=`${output}.installation.json`,publicKeyPem=createPublicKey(privateKey).export({type:"spki",format:"pem"}).toString();
writeFileSync(sidecar,canonicalJson({installation:{root:realpathSync(output),manifest:material,review},authority:{keyId:review.keyId,publicKeyPem,
  packageIds:[descriptor.id],validFrom:issuedAt,validUntil:review.expiresAt}})+"\n",{flag:"wx"});
console.log(`Packaged ${descriptor.id}@${descriptor.version} at ${realpathSync(output)}`);
console.log(`Host installation material: ${sidecar}`);

function parseFlags(args:string[]):Record<string,string>{const result:Record<string,string>={},supported=new Set(["source","output","private-key","key-id","review-ref","expires-at"]);for(let index=0;index<args.length;index+=2){
  const key=args[index],value=args[index+1];if(!key?.startsWith("--")||value===undefined||value.startsWith("--"))throw new Error("Scenario package arguments must be --name value pairs");
  const name=key.slice(2);if(!supported.has(name))throw new Error(`Unsupported argument ${key}`);if(result[name])throw new Error(`Duplicate argument ${key}`);result[name]=value;}return result;}
function required(value:string|undefined,label:string){if(!value?.trim()||Buffer.byteLength(value)>256)throw new Error(`${label} is required`);return value.trim();}
function absolute(value:string|undefined,label:string){const path=required(value,label);if(!isAbsolute(path))throw new Error(`${label} must be absolute`);return resolve(path);}
function realDirectory(value:string|undefined,label:string){const path=absolute(value,label),real=realpathSync(path),stat=lstatSync(path);if(path!==real||!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`${label} must be a real directory`);return real;}
function realFile(value:string|undefined,label:string){const path=absolute(value,label),real=realpathSync(path),stat=lstatSync(path);if(path!==real||!stat.isFile()||stat.isSymbolicLink())throw new Error(`${label} must be a real file`);return real;}
function iso(value:string|undefined,label:string){const text=required(value,label);if(!Number.isFinite(Date.parse(text))||Date.parse(text)<=Date.now())throw new Error(`${label} must be a future ISO timestamp`);return text;}
