// Run with Electron after the desktop build and prepare:runtime. No existing
// user data, model account, Scenario installation or external target is used.
import { app, BrowserWindow, dialog } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../apps/server/dist/development-loader.js";
register();
app.setPath("userData", mkdtempSync(join(tmpdir(), "traceforge-launch-check-")));
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
const deadline = setTimeout(() => { console.error("Desktop launch timed out"); app.exit(1); }, 20000);
await import("../apps/desktop/dist/main.js");
const poll = setInterval(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.webContents.isLoading()) return;
  clearInterval(poll);
  try {
    const state = await window.webContents.executeJavaScript("({text:document.body.innerText, bridge:window.traceforgeDesktop?.conversations?.protocolVersion})");
    if (state.bridge !== 1 || !state.text.includes("会话记录")) throw new Error("Formal renderer or preload unavailable");
    console.log("FORMAL_DESKTOP_SMOKE_OK"); clearTimeout(deadline); app.quit();
  } catch (error) { console.error(error); app.exit(1); }
}, 250);
