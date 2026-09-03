import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "@traceforge/orchestration-core";
import { ScenarioProcessArchiveExportSigner } from "../src/scenario-process-archive-export.ts";
import { ScenarioProcessColdArchive } from "../src/scenario-process-cold-archive.ts";

const [root,keyPath,phase,mode]=process.argv.slice(2),now="2026-09-02T00:00:30.000Z",signer=new ScenarioProcessArchiveExportSigner({keyId:"archive-key",privateKeyPem:readFileSync(keyPath,"utf8"),validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z"},()=>now);
const body=canonicalJson({format:"traceforge.scenario-process-retired-receipts.v1",package:{id:"fixture.package",version:"1.0.0"},records:[]}),payload=gzipSync(body),archive=signer.sign({package:{id:"fixture.package",version:"1.0.0"},archiveDigest:createHash("sha256").update(canonicalJson(JSON.parse(body))).digest("hex"),originalBytes:Buffer.byteLength(body),compressedBytes:payload.length,createdAt:"2026-09-02T00:00:00.000Z",payloadBase64:payload.toString("base64")});
const checkpoint={async reached(boundary){if(mode==="crash"&&boundary===phase){process.stdout.write(`${JSON.stringify({boundary})}\n`);await new Promise(()=>{});}}},cold=new ScenarioProcessColdArchive({root,authority:key=>key===signer.keyId?signer.authority():undefined,authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"cold-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}}},()=>now,checkpoint);
const receive={commandId:"receive",actor:"operator",reason:"retain independently",archive};await cold.receive(receive);
if(phase.startsWith("purge_")){await cold.release({commandId:"release",actor:"operator",reason:"retention approved",archiveDigest:archive.archiveDigest,expectedRevision:0});await cold.purge({commandId:"purge",actor:"operator",reason:"authorized destruction",archiveDigest:archive.archiveDigest,expectedRevision:1});}
if(mode==="recover"){const records=cold.inventory({}).records,retentionPath=`${root}/retention/${archive.archiveDigest}`;let revision=0;try{revision=(await import("node:fs")).readdirSync(retentionPath).length;}catch{}process.stdout.write(`${JSON.stringify({archiveDigest:archive.archiveDigest,records,revision})}\n`);}
