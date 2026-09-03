import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});const fixture=fileURLToPath(new URL("../test-fixtures/scenario-process-cold-archive-crash-host.mjs",import.meta.url));
function host(root:string,key:string,phase:string,mode:"crash"|"recover"){return new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,root,key,phase,mode],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});let output="",errors="",stopped=false;
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Scenario Process cold archive fixture deadline"));},15000);child.stdout.on("data",chunk=>{output+=chunk.toString();if(mode==="crash"&&output.includes("\n")&&!stopped){stopped=true;child.kill("SIGKILL");}});child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("exit",(code,signal)=>{clearTimeout(timer);if(mode==="crash")return stopped&&signal==="SIGKILL"?resolve(undefined):reject(new Error(errors||output));if(code!==0)return reject(new Error(errors||output));try{resolve(JSON.parse(output.trim().split("\n").at(-1)!));}catch(error){reject(error);}});});}
async function run(phase:string){const root=mkdtempSync(join(tmpdir(),"traceforge-cold-crash-")),key=join(root,"key.pem"),keys=generateKeyPairSync("ed25519");roots.push(root);writeFileSync(key,keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),{mode:0o600});await host(root,key,phase,"crash");return host(root,key,phase,"recover");}

describe("Scenario Process cold archive actual host termination",()=>{
  it.each(["receive_staged","receive_published"])("recovers %s with one verified archive",async phase=>{const result=await run(phase);expect(result.records).toMatchObject([{archiveDigest:result.archiveDigest,retentionState:"forensic_hold"}]);expect(result.revision).toBe(0);},30000);
  it.each(["purge_prepared","purge_removed"])("recovers %s without restoring destroyed evidence",async phase=>{const result=await run(phase);expect(result.records).toEqual([]);expect(result.revision).toBe(3);},30000);
});
