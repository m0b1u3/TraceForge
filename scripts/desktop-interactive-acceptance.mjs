// Isolated native desktop for manual/CUA acceptance. No renderer automation.
// Reuses OS-encrypted model configuration without changing the user's profile.
import { app, safeStorage } from "electron";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "../apps/server/dist/development-loader.js";
register();
async function launch(){
const [mode,source,fixtureFlag]=process.argv.slice(2);
if(fixtureFlag&&fixtureFlag!=="--with-fixtures")throw new Error("Unknown acceptance option");
if(!["--config-directory","--restore","--deepseek-stdin"].includes(mode)||!source)throw new Error("Explicit configuration directory, isolated restore directory or --deepseek-stdin isolated required");
if(mode==="--deepseek-stdin"&&source!=="isolated")throw new Error("DeepSeek stdin requires isolated destination");
let root;
if(mode==="--restore"){
  root=realpathSync(resolve(source));
  if(!root.startsWith(join(realpathSync(tmpdir()),"traceforge-interactive-")))throw new Error("Not an isolated acceptance directory");
}else{
  root=mkdtempSync(join(realpathSync(tmpdir()),"traceforge-interactive-"));
  const directory=join(root,"config");mkdirSync(directory,{mode:0o700});
  for(const name of mode==="--deepseek-stdin"?[]:["llm.json","llm-secrets.bin","model-tokens.bin","model-accounts.json"]){
    const path=join(resolve(source),name);if(existsSync(path))copyFileSync(path,join(directory,name));
  }
}
app.setPath("userData",root);
if(mode==="--deepseek-stdin"){
  await app.whenReady();
  if(!safeStorage.isEncryptionAvailable())throw new Error("Secure storage unavailable");
  const input=createInterface({input:process.stdin,terminal:false});
  let line="";for await(const value of input){line=value;break;}input.close();
  const {LlmConfigSchema}=await import("../packages/llm/src/config.ts");
  let config;try{if(line.length>16384)throw new Error();config=LlmConfigSchema.parse(JSON.parse(line));}catch{throw new Error("Invalid isolated model configuration");}finally{line="";}
  const endpoint=new URL(config.baseUrl??"");
  if(config.provider!=="openai"||!config.model.startsWith("deepseek-")||endpoint.href!=="https://api.deepseek.com/"||!config.apiKey||config.alternativeRoutes?.length)throw new Error("Acceptance requires official DeepSeek only");
  const {apiKey,...publicConfig}=config;
  writeFileSync(join(root,"config","llm-secrets.bin"),safeStorage.encryptString(JSON.stringify({primary:apiKey,alternativeRoutes:{}})),{mode:0o600});
  writeFileSync(join(root,"config","llm.json"),JSON.stringify(publicConfig),{mode:0o600});
}
const selected=JSON.parse(readFileSync(join(root,"config","llm.json"),"utf8"));
if(selected.provider!=="openai"||!selected.model?.startsWith("deepseek-")||new URL(selected.baseUrl).href!=="https://api.deepseek.com/"||selected.alternativeRoutes?.length)throw new Error("Acceptance requires official DeepSeek only");
if(fixtureFlag){
  if(process.platform==="darwin"){
    const helperRoot=resolve("packages/execution-node/native/darwin-arm64");
    process.env.TRACEFORGE_MACOS_SANDBOX_HELPER=join(helperRoot,"traceforge-macos-sandbox");
    process.env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST=join(helperRoot,"release.json");
    process.env.TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST="1";
  }
  const fixtures=await import("./desktop-acceptance-fixtures.mjs");
  await fixtures.installAcceptanceFixtures(root);
  const close=await fixtures.startAcceptanceMcp(root);app.on("will-quit",close);
}
console.log(JSON.stringify({event:"isolated_desktop",root,restored:mode==="--restore"}));
await import("../apps/desktop/dist/main.js");
}
void launch().catch(()=>{console.error(JSON.stringify({event:"isolated_desktop_failed",detailsRedacted:true}));app.exit(1);});
