import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "@traceforge/orchestration-core";
import { parseScenarioPackageDescriptor, ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import type { ScenarioPackageReview, ScenarioReviewedInstallation } from "./scenario-package-trust.js";

const descriptorPath = "scenario.json";
interface DescriptorOrigin {root:string;materialDigest:string;descriptorDigest:string;files:ReadonlyMap<string,{path:string;role:"entry"|"dependency"|"data";size:number;digest:string}>}
const origins = new WeakMap<ScenarioPackageInstallation,DescriptorOrigin>();
export interface ScenarioPackageDescriptorResources {
  context: Array<{package:{id:string;version:string;schemaRevision:number};resourceId:string;content:string}>;
  migrations: Array<{package:{id:string;version:string;schemaRevision:number};resourceId:string;content:string}>;
}

/** Loads only bounded JSON from already-declared material. Trust/signature enforcement remains in ScenarioPackageTrustControl. */
export function loadScenarioPackageDescriptors(installations:readonly ScenarioReviewedInstallation[]):ScenarioPackageRegistry {
  if(installations.length>256)throw new Error("Scenario Package descriptor count exceeds limit");
  const packages=installations.map((installation)=>{
    if(!isAbsolute(installation.root))throw new Error("Scenario Package descriptor root must be absolute");
    const root=resolve(installation.root);
    if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw new Error("Scenario Package descriptor root must be a real directory");
    const files=installation.manifest.files;
    if(!Array.isArray(files))throw new Error("Scenario Package material file list is invalid");
    if(files.length<1||files.length>128||new Set(files.map(file=>file.path)).size!==files.length
      ||files.some(file=>!safeMaterialPath(file.path)||!["entry","dependency","data"].includes(file.role)
        ||!Number.isSafeInteger(file.size)||file.size<0||file.size>1024*1024||!/^sha256:[a-f0-9]{64}$/.test(file.digest))
      ||!safeMaterialPath(installation.manifest.entry)||files.filter(file=>file.role==="entry").length!==1
      ||files.find(file=>file.path===installation.manifest.entry)?.role!=="entry")throw new Error("Scenario Package material manifest is invalid");
    const descriptor=files.filter(file=>file.path===descriptorPath);
    if(descriptor.length!==1||descriptor[0]!.role!=="data")throw new Error("Scenario Package material must declare scenario.json as data");
    if(descriptor[0]!.size>1024*1024)throw new Error("Scenario Package descriptor exceeds byte limit");
    const absolute=join(root,descriptorPath),stat=lstatSync(absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==descriptor[0]!.size)throw new Error("Scenario Package descriptor file does not match material");
    const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
    let bytes:Buffer;
    try{const before=fstatSync(fd);bytes=readFileSync(fd);const after=fstatSync(fd);
      if(bytes.length!==descriptor[0]!.size||before.ino!==stat.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error("Scenario Package descriptor changed while loading");
    }finally{closeSync(fd);}
    const digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if(digest!==descriptor[0]!.digest)throw new Error("Scenario Package descriptor digest mismatch");
    let parsed:unknown;try{parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new Error("Scenario Package descriptor is not valid UTF-8 JSON");}
    const pkg=parseScenarioPackageDescriptor(parsed),binding={id:pkg.id,version:pkg.version,schemaRevision:pkg.schemaRevision};
    if(canonicalJson(binding)!==canonicalJson(installation.manifest.package)||canonicalJson(binding)!==canonicalJson(installation.review.package)){
      throw new Error("Scenario Package descriptor identity does not match reviewed material");
    }
    const entry=pkg.runtime!.entrypoint.slice("package://".length),declared=files.filter(file=>file.path===entry);
    if(declared.length!==1||declared[0]!.role!=="entry"||installation.manifest.entry!==entry){
      throw new Error("Scenario Package descriptor runtime does not match the reviewed entry");
    }
    for(const resource of pkg.resourceManifest?.resources??[]){
      if(resource.context?.external)continue;
      if(!resource.locator.startsWith("package://"))throw new Error("Local Scenario resource must use package:// material");
      const path=resource.locator.slice("package://".length),material=files.filter(file=>file.path===path);
      if(material.length!==1||material[0]!.role!=="data"||material[0]!.digest!==resource.digest||path===descriptorPath){
        throw new Error("Scenario resource does not match reviewed data material");
      }
    }
    const materialDigest=`sha256:${createHash("sha256").update(canonicalJson(installation.manifest)).digest("hex")}`;
    if(materialDigest!==installation.review.materialDigest)throw new Error("Scenario Package review does not cover its material manifest");
    origins.set(pkg,{root,materialDigest,descriptorDigest:digest,files:new Map(files.map(file=>[file.path,Object.freeze({...file})]))});return pkg;
  });
  return new ScenarioPackageRegistry(packages);
}

/** Internal trust bridge: proves this immutable object came from the exact descriptor in the reviewed directory. */
export function assertScenarioPackageDescriptorAssembly(pkg:ScenarioPackageInstallation,installation:ScenarioReviewedInstallation,
  review:ScenarioPackageReview):void {
  const origin=origins.get(pkg),descriptor=installation.manifest.files.find(file=>file.path===descriptorPath);
  if(!origin||origin.root!==resolve(installation.root)||origin.materialDigest!==review.materialDigest||origin.descriptorDigest!==descriptor?.digest){
    throw new Error("Trusted host assembly attestation is missing");
  }
}
export function isScenarioPackageDescriptorAssembly(pkg:ScenarioPackageInstallation):boolean{return origins.has(pkg);}

/** Reads only currently trusted local text resources; unavailable packages remain quarantined until a fresh Host assembly. */
export function readScenarioPackageDescriptorResources(registry:ScenarioPackageRegistry):ScenarioPackageDescriptorResources {
  const result:ScenarioPackageDescriptorResources={context:[],migrations:[]};
  for(const pkg of registry.list()){
    const binding=registry.bindingFor(pkg);
    if(registry.bindingStatus(binding,pkg.definition.kind,pkg.definition.version).status!=="available")continue;
    const origin=origins.get(pkg);if(!origin)continue;
    for(const resource of pkg.resourceManifest?.resources??[]){
      if(resource.context?.external||(!resource.context&&resource.kind!=="migration"))continue;
      const path=resource.locator.slice("package://".length),file=origin.files.get(path);
      if(!file||file.role!=="data"||file.digest!==resource.digest)throw new Error("Scenario descriptor resource origin changed");
      const bytes=readStableFile(origin.root,file,64*1024),actual=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if(actual!==resource.digest)throw new Error("Scenario descriptor resource digest mismatch");
      let content:string;try{content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("Scenario descriptor resource must be UTF-8 text");}
      (resource.context?result.context:result.migrations).push({package:binding,resourceId:resource.id,content});
    }
  }
  return result;
}

function readStableFile(root:string,file:{path:string;size:number},maximumBytes:number):Buffer{
  if(file.size>maximumBytes)throw new Error("Scenario descriptor resource exceeds byte limit");
  const absolute=join(root,file.path),stat=lstatSync(absolute);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size)throw new Error("Scenario descriptor resource file does not match material");
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=fstatSync(fd),bytes=readFileSync(fd),after=fstatSync(fd);
    if(bytes.length!==file.size||before.ino!==stat.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error("Scenario descriptor resource changed while loading");return bytes;
  }finally{closeSync(fd);}
}
function safeMaterialPath(path:unknown):path is string{return typeof path==="string"&&path.length>0&&path.length<=512
  &&path.split("/").every(part=>part!=="."&&part!==".."&&/^[a-zA-Z0-9_.-]+$/.test(part));}
