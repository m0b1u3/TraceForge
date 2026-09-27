import {createHash} from "node:crypto";
import {chmodSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseScenarioPackageDescriptor} from "../packages/scenario-sdk/src/index.js";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const source=join(root,"scenarios/web-blackbox"),output=join(root,"apps/desktop/bundled-scenarios");
const destination=join(output,"web-blackbox");
const descriptor=JSON.parse(readFileSync(join(source,"scenario.json"),"utf8"));
const runtimeFiles=readdirSync(join(source,"runtime")).filter(name=>name.endsWith(".mjs")).sort().map(name=>`runtime/${name}`);
const resourceFiles=(descriptor.resourceManifest?.resources??[])
  .filter((resource:{context?:{external?:boolean}})=>!resource.context?.external)
  .map((resource:{locator:string})=>resource.locator.slice("package://".length));
const paths=[...new Set([...runtimeFiles,...resourceFiles])].sort();
for(const resource of descriptor.resourceManifest?.resources??[]){
  if(resource.context?.external)continue;
  const path=resource.locator.slice("package://".length);
  resource.digest=`sha256:${createHash("sha256").update(readFileSync(join(source,path))).digest("hex")}`;
}
const hash=createHash("sha256").update(JSON.stringify(descriptor));
for(const path of paths)hash.update(path).update(readFileSync(join(source,path)));
const revision=`b${hash.digest("hex").slice(0,16)}`;
descriptor.package.version=revision;
descriptor.runtime.version=revision;
parseScenarioPackageDescriptor(descriptor);

mkdirSync(output,{recursive:true});
rmSync(destination,{recursive:true,force:true});
mkdirSync(destination,{recursive:true});
for(const path of paths){
  const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});
  if(path==="runtime/contracts.mjs"){
    const content=readFileSync(join(source,path),"utf8");
    const patched=content.replace('export const PACKAGE_VERSION = "builtin";',`export const PACKAGE_VERSION = "${revision}";`);
    if(patched===content)throw new Error("Scenario runtime identity declaration is missing");
    writeFileSync(target,patched);
  }else copyFileSync(join(source,path),target);
}
writeFileSync(join(destination,"scenario.json"),JSON.stringify(descriptor,null,2));
const node=realpathSync(process.execPath),nodeName=process.platform==="win32"?"node.exe":"node";
copyFileSync(node,join(output,nodeName));chmodSync(join(output,nodeName),0o755);
for(const item of readdirSync(output,{withFileTypes:true})){
  if(item.isDirectory()&&/^web-blackbox-[0-9]+[.][0-9]+[.][0-9]+-[a-f0-9]{12}$/.test(item.name))
    rmSync(join(output,item.name),{recursive:true});
}
if(existsSync(join(output,"catalog.json")))rmSync(join(output,"catalog.json"));
console.log("Bundled the built-in Scenario in a stable directory");
