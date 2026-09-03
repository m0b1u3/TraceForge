import { createHash, generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@traceforge/orchestration-core";
import { ScenarioProcessArchiveExportSigner } from "./scenario-process-archive-export.js";
import { ScenarioProcessColdArchive } from "./scenario-process-cold-archive.js";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});const now="2026-09-02T00:00:30.000Z";
function setup(checkpoint?:{reached(phase:string):void}){const root=mkdtempSync(join(tmpdir(),"traceforge-cold-"));roots.push(root);const keys=generateKeyPairSync("ed25519"),signer=new ScenarioProcessArchiveExportSigner({keyId:"archive-key",privateKeyPem:keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z"},()=>now);
  const authorizer={async authorize(){return {decision:"allowed" as const,authorizationRef:"cold-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}},cold=new ScenarioProcessColdArchive({root,authority:key=>key===signer.keyId?signer.authority():undefined,authorizer},()=>now,checkpoint as any);
  const archive=(id:string)=>{const body=canonicalJson({format:"traceforge.scenario-process-retired-receipts.v1",package:{id,version:"1.0.0"},records:[]}),payload=gzipSync(body);return signer.sign({package:{id,version:"1.0.0"},archiveDigest:createHash("sha256").update(canonicalJson(JSON.parse(body))).digest("hex"),originalBytes:Buffer.byteLength(body),compressedBytes:payload.length,createdAt:"2026-09-02T00:00:00.000Z",payloadBase64:payload.toString("base64")});};return {root,cold,archive,signer};}

describe("independent Scenario Process cold archive",()=>{
  it("atomically receives, verifies, inventories and replays an archive without an active database",async()=>{const {root,cold,archive}=setup(),value=archive("fixture.package"),request={commandId:"receive-1",actor:"operator",reason:"independent retention",archive:value};
    expect(await cold.receive(request)).toMatchObject({outcome:"received",replayed:false});expect(await cold.receive(request)).toMatchObject({outcome:"received",replayed:true});expect(cold.inventory({})).toMatchObject({records:[{archiveDigest:value.archiveDigest,retentionState:"forensic_hold",secureErase:false}]});
    const payload=readFileSync(join(root,"archives",value.archiveDigest,"payload.gz"));expect(payload.toString("base64")).toBe(value.payloadBase64);
  });
  it("requires release before purge, preserves neighboring archives, and never claims secure erasure",async()=>{const {root,cold,archive}=setup(),first=archive("first.package"),second=archive("second.package");
    await cold.receive({commandId:"receive-first",actor:"operator",reason:"retain",archive:first});await cold.receive({commandId:"receive-second",actor:"operator",reason:"retain",archive:second});
    await expect(cold.purge({commandId:"purge-early",actor:"operator",reason:"too early",archiveDigest:first.archiveDigest,expectedRevision:0})).rejects.toThrow(/forensic hold/);
    expect(await cold.release({commandId:"release-first",actor:"operator",reason:"retention approved",archiveDigest:first.archiveDigest,expectedRevision:0})).toMatchObject({outcome:"destroyable",secureErase:false});
    expect(await cold.purge({commandId:"purge-first",actor:"operator",reason:"authorized destruction",archiveDigest:first.archiveDigest,expectedRevision:1})).toMatchObject({outcome:"destroyed",secureErase:false});
    expect(cold.inventory({}).records).toMatchObject([{archiveDigest:second.archiveDigest}]);expect(()=>cold.inspect(first.archiveDigest)).toThrow();expect(cold.inspect(second.archiveDigest).retentionState).toBe("forensic_hold");
    expect(readFileSync(join(root,"retention",first.archiveDigest,"0000000003.json"),"utf8")).toContain('"secureErase":false');
  });
  it("recovers published receive and prepared purge after injected host interruption",async()=>{let fail="receive_published";const checkpoint={reached(phase:string){if(phase===fail){fail="";throw new Error("host interrupted");}}},{cold,archive}=setup(checkpoint),value=archive("fixture.package"),receive={commandId:"receive-crash",actor:"operator",reason:"recover",archive:value};
    await expect(cold.receive(receive)).rejects.toThrow(/interrupted/);expect(await cold.receive(receive)).toMatchObject({outcome:"received"});await cold.release({commandId:"release",actor:"operator",reason:"release",archiveDigest:value.archiveDigest,expectedRevision:0});
    fail="purge_removed";const purge={commandId:"purge-crash",actor:"operator",reason:"destroy",archiveDigest:value.archiveDigest,expectedRevision:1};await expect(cold.purge(purge)).rejects.toThrow(/interrupted/);expect(await cold.purge(purge)).toMatchObject({outcome:"destroyed"});
  });
  it("fails closed on authorization, revoked keys and unexpected archive entries",async()=>{const {root,cold,archive,signer}=setup(),value=archive("fixture.package");const denied=new ScenarioProcessColdArchive({root:join(root,"denied"),authority:()=>signer.authority()},()=>now);
    await expect(denied.receive({commandId:"denied",actor:"operator",reason:"no policy",archive:value})).resolves.toMatchObject({outcome:"denied"});const received={commandId:"receive",actor:"operator",reason:"retain",archive:value};await cold.receive(received);
    const revoked=new ScenarioProcessColdArchive({root:join(root,"revoked"),authority:()=>({...signer.authority(),revoked:true}),authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"cold-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}}},()=>now);await expect(revoked.receive({...received,commandId:"revoked"})).rejects.toThrow(/authority/);
    writeFileSync(join(root,"archives",value.archiveDigest,"unexpected"),"do not delete");await expect(cold.release({commandId:"release",actor:"operator",reason:"release",archiveDigest:value.archiveDigest,expectedRevision:0})).rejects.toThrow(/unexpected/);
  });
});
