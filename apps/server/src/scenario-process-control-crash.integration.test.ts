import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const fixture=fileURLToPath(new URL("../test-fixtures/scenario-process-control-crash-host.mjs",import.meta.url));

async function run(phase:string){const root=mkdtempSync(join(tmpdir(),"traceforge-scenario-control-crash-"));roots.push(root);const db=join(root,"state.db"),key=join(root,"key.pem"),keys=generateKeyPairSync("ed25519");
  writeFileSync(key,keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),{mode:0o600});
  await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,db,key,phase,"crash"],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
    let output="",errors="",killed=false;const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Scenario Process control crash fixture deadline"));},15000);
    child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("ready\n")&&!killed){killed=true;child.kill("SIGKILL");}});child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
    child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("exit",(_code,signal)=>{clearTimeout(timer);signal==="SIGKILL"?resolve():reject(new Error(errors||output));});});
  return await new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,db,key,phase,"recover"],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
    let output="",errors="";const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Scenario Process control recovery fixture deadline"));},15000);
    child.stdout.on("data",chunk=>{output+=chunk.toString();});child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("exit",code=>{clearTimeout(timer);if(code===0){try{resolve(JSON.parse(output.trim().split("\n").at(-1)!));}catch(error){reject(error);}}else reject(new Error(errors||output));});});}

describe("Scenario Process control actual host termination",()=>{
  it.each(["reconcile_uncommitted","reconcile_committed"])("recovers %s without a half-settled capability",async phase=>{const result=await run(phase);
    expect(result).toMatchObject({replayed:phase==="reconcile_committed",outcome:"resolved_succeeded",capability:"succeeded",evidence:1,archives:0,integrity:"ok"});},30000);
  it.each(["retire_uncommitted","retire_committed"])("recovers %s without a half-retired Package version",async phase=>{const result=await run(phase);
    expect(result).toMatchObject({replayed:phase==="retire_committed",outcome:"retired",capability:null,state:"retired",evidence:0,archives:1,integrity:"ok"});},30000);
});
