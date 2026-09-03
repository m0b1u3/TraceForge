import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ScenarioPackageTrustOptions, ScenarioReviewedInstallation } from "./scenario-package-trust.js";
import type { ScenarioProcessLaunch } from "@traceforge/worker-runtime";

const text=z.string().trim().min(1).max(1024),date=z.string().datetime();
const pathGrant=z.object({path:text,scope:z.enum(["exact","tree"])}).strict();
const attribution=z.object({caseId:text,runId:text,workId:text,workerId:text,scopeRef:text,leaseId:text,leaseExpiresAt:date,
  actionId:text,idempotencyKey:text}).strict();
const permissions=z.object({version:z.literal(1),platform:z.enum(["windows","linux","darwin"]),filesystem:z.object({
  read:z.array(pathGrant).max(128),write:z.array(pathGrant).max(128),deny:z.array(pathGrant).max(128)}).strict(),
  network:z.enum(["deny","brokered","direct"]),process:z.object({access:z.enum(["deny","sandboxed","unrestricted"]),
    interactive:z.boolean(),background:z.boolean()}).strict(),secrets:z.enum(["deny","handles_only","plaintext"]),
  sources:z.array(text).min(1).max(32)}).strict();
const resources=z.object({cpuTimeMs:z.number().int().positive().max(86_400_000),memoryBytes:z.number().int().positive(),
  maximumProcesses:z.number().int().positive().max(1024),writeBytes:z.number().int().nonnegative()}).strict();
const launch=z.object({source:text,executable:text,arguments:z.array(z.string().max(4096)).max(128).default([]),workingDirectory:text,
  environment:z.record(z.string().max(16_384)).optional(),attribution,permissions,resources,expectedSandboxBackend:text.optional(),
  processTimeoutMs:z.number().int().positive().max(86_400_000).optional(),outputLimitBytes:z.number().int().positive().max(64*1024*1024).optional()}).strict();
const authority=z.object({keyId:text,publicKeyPem:z.string().min(1).max(16*1024),packageIds:z.array(text).min(1).max(256),
  validFrom:date,validUntil:date,revoked:z.boolean().optional()}).strict();
const envelope=z.object({format:z.literal("traceforge.scenario-host.v1"),installations:z.array(z.object({root:text,
  manifest:z.unknown(),review:z.unknown()}).strict()).max(256),authorities:z.array(authority).max(256),launches:z.array(launch).max(256)}).strict();

export interface ScenarioHostConfiguration {
  trust: ScenarioPackageTrustOptions;
  launches: Readonly<Record<string,ScenarioProcessLaunch>>;
}

/** Reads deployment choices only. Package code and descriptor data are loaded by the existing reviewed loader. */
export function loadScenarioHostConfiguration(path:string):ScenarioHostConfiguration {
  let bytes:Buffer;try{bytes=readFileSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {trust:{installations:[]},launches:{}};throw error;}
  if(bytes.length>4*1024*1024)throw new Error("Scenario Host configuration exceeds byte limit");
  let raw:unknown;try{raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new Error("Scenario Host configuration is not valid UTF-8 JSON");}
  const value=envelope.parse(raw),base=dirname(resolve(path)),authorities=new Map(value.authorities.map(item=>[item.keyId,item]));
  if(authorities.size!==value.authorities.length)throw new Error("Duplicate Scenario review authority");
  const installations=value.installations.map(item=>({root:resolvePath(base,item.root),manifest:structuredClone(item.manifest),review:structuredClone(item.review)} as ScenarioReviewedInstallation));
  const launches:Record<string,ScenarioProcessLaunch>={};
  for(const item of value.launches){if(launches[item.source])throw new Error("Duplicate Scenario Process launch profile");
    launches[item.source]={executable:resolveExecutable(base,item.executable),arguments:item.arguments.map(argument=>resolveArgument(base,argument)),
      workingDirectory:resolvePath(base,item.workingDirectory),...(item.environment?{environment:{...item.environment}}:{}),
      attribution:structuredClone(item.attribution),permissions:structuredClone(item.permissions),resources:structuredClone(item.resources),
      ...(item.expectedSandboxBackend?{expectedSandboxBackend:item.expectedSandboxBackend}:{}),
      ...(item.processTimeoutMs?{processTimeoutMs:item.processTimeoutMs}:{}),...(item.outputLimitBytes?{outputLimitBytes:item.outputLimitBytes}:{})};}
  return {trust:{installations,authority:key=>{const item=authorities.get(key);return item?structuredClone(item):undefined;}},launches:Object.freeze(launches)};
}

function resolvePath(base:string,value:string){return isAbsolute(value)?resolve(value):resolve(base,value);}
function resolveExecutable(base:string,value:string){return value==="@host/node"?process.execPath:resolvePath(base,value);}
function resolveArgument(base:string,value:string){return value.startsWith("@config/")?resolve(base,value.slice("@config/".length)):value;}
