// Isolated native desktop for manual/CUA acceptance. No renderer automation.
// Reuses OS-encrypted model configuration without changing the user's profile.
import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "../apps/server/dist/development-loader.js";
register();
const [mode,source]=process.argv.slice(2);
if(!["--config-directory","--restore"].includes(mode)||!source)throw new Error("Explicit configuration directory or isolated restore directory required");
let root;
if(mode==="--restore"){
  root=realpathSync(resolve(source));
  if(!root.startsWith(join(realpathSync(tmpdir()),"traceforge-interactive-")))throw new Error("Not an isolated acceptance directory");
}else{
  root=mkdtempSync(join(tmpdir(),"traceforge-interactive-"));
  const directory=join(root,"config");mkdirSync(directory,{mode:0o700});
  for(const name of ["llm.json","llm-secrets.bin","model-tokens.bin","model-accounts.json"]){
    const path=join(resolve(source),name);if(existsSync(path))copyFileSync(path,join(directory,name));
  }
}
app.setPath("userData",root);
console.log(JSON.stringify({event:"isolated_desktop",root,restored:mode==="--restore"}));
await import("../apps/desktop/dist/main.js");
