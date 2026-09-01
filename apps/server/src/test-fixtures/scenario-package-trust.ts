import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { scenarioMaterialDigest, scenarioPackageContractDigest, signScenarioPackageReview,
  type ScenarioMaterialManifest, type ScenarioPackageTrustOptions } from "../scenario-package-trust.js";

export function reviewedMaterial(root:string,pkg:ScenarioPackageInstallation){
  mkdirSync(root,{recursive:true});
  const files=[{path:"entry.mjs",role:"entry" as const,body:"export const assemblyRef = 'fixture-reviewed-object';\n"},
    {path:"dependency.mjs",role:"dependency" as const,body:"export const dependency = 1;\n"}];
  for(const file of files)writeFileSync(join(root,file.path),file.body);
  const manifest:ScenarioMaterialManifest={format:"traceforge.scenario-material.v1",package:{id:pkg.id,version:pkg.version,schemaRevision:pkg.schemaRevision},entry:"entry.mjs",
    files:files.map(f=>({path:f.path,role:f.role,size:Buffer.byteLength(f.body),digest:`sha256:${createHash("sha256").update(f.body).digest("hex")}`}))};
  const keys=generateKeyPairSync("ed25519"),privateKeyPem=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const authority={publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),packageIds:[pkg.id],validFrom:"2026-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z",revoked:false};
  const review=signScenarioPackageReview({format:"traceforge.scenario-review.v1",package:manifest.package,materialDigest:scenarioMaterialDigest(manifest),
    contractDigest:scenarioPackageContractDigest(pkg),assemblyRef:"fixture-reviewed-object",keyId:"fixture-authority",reviewRef:"fixture-review",issuedAt:"2026-01-02T00:00:00.000Z",expiresAt:"2098-01-01T00:00:00.000Z"},privateKeyPem);
  const installation={root:realpathSync(root),manifest,review};
  const options:ScenarioPackageTrustOptions={installations:[installation],authority:key=>key===review.keyId?authority:undefined,
    // Fixture-only trusted association. No claim that this callback is a real code loader or independent audit.
    assertAssembly(actual,endorsement){if(actual!==pkg || endorsement.assemblyRef!=="fixture-reviewed-object")throw new Error("Unexpected host assembly");},
    revokeAuthorizer:{async authorize(){return {decision:"allowed",authorizationRef:"fixture-approved",expiresAt:"2099-01-01T00:00:00.000Z"};}}};
  return {files,installation,options,authority,privateKeyPem};
}
