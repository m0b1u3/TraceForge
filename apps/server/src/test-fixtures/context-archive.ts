import { generateKeyPairSync } from "node:crypto";
import type Database from "better-sqlite3";
import { ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { contextPackage, contextBinding, contextText, enableSkillContract } from "./context-package.js";
import { database } from "./execution-recovery.js";
import { SqlitePackageContextStore, contextContentDigest } from "../package-context-resources.js";
import { ContextPackageArchiveControl, type ContextPackageTransferOptions } from "../context-package-archive.js";

const keys=generateKeyPairSync("ed25519");
export const archivePrivateKey=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
export const archivePublicKey=keys.publicKey.export({type:"spki",format:"pem"}).toString();
export const secondText="Independent reference material; not evidence or permission.";
export function archivePackage(){
  const pkg=contextPackage();enableSkillContract(pkg);
  const first=pkg.resourceManifest!.resources[0]!;first.context!.references=["second"];
  pkg.resourceManifest={revision:1,resources:[first,{id:"second",kind:"text",version:1,locator:"package:second",digest:contextContentDigest(secondText),
    context:{type:"knowledge",summary:"Reference",authorizationAction:"context.read",requiredCapabilities:["context.read"],phaseIds:["observe"],references:[]}}]};
  return pkg;
}
export function transferOptions():ContextPackageTransferOptions {
  return {signer:{keyId:"fixture",privateKeyPem:archivePrivateKey},authority:()=>({publicKeyPem:archivePublicKey,packageIds:["neutral"],validFrom:"2026-01-01T00:00:00Z",validUntil:"2099-01-01T00:00:00Z"}),
    authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"test-only-transfer",expiresAt:"2099-01-01T00:00:00Z"};}}};
}
export function archiveFixture(seed=true,sqlite:Database.Database=database(),options=transferOptions(),pkg=archivePackage()): {
  sqlite:Database.Database;packages:ScenarioPackageRegistry;pkg:ScenarioPackageInstallation;
  store:SqlitePackageContextStore;control:ContextPackageArchiveControl;options:ContextPackageTransferOptions;
} {
  const packages=new ScenarioPackageRegistry([pkg]);let control:ContextPackageArchiveControl;
  const store=new SqlitePackageContextStore(sqlite,undefined,binding=>control.assertImportedTrust(binding));
  control=new ContextPackageArchiveControl(sqlite,packages,store,options);
  if(seed)store.install(packages,[{package:contextBinding,resourceId:"first",content:contextText},{package:contextBinding,resourceId:"second",content:secondText}]);
  return {sqlite,packages,pkg,store,control,options};
}
export function transfer(action:"export"|"import",archive?:unknown,commandId:string=action){return {
  commandId,actor:"operator",reason:"Move reviewed context",action,package:contextBinding,...(archive===undefined?{}:{archive})};}
