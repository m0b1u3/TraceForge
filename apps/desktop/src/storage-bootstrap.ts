import { app } from "electron";
import { mkdirSync } from "node:fs";
import { storageLayout } from "./storage-layout.js";

export function configureDesktopStorage() {
  const layout = storageLayout({ appData: app.getPath("appData"), home: app.getPath("home"), current: app.getPath("userData"), appName: app.getName(), packaged: app.isPackaged, platform: process.platform });
  for (const path of [layout.root, layout.cache]) mkdirSync(path, { recursive: true, mode: 0o700 });
  app.setPath("userData", layout.root);
  app.setPath("sessionData", layout.root);
  try { mkdirSync(layout.logs, { recursive: true, mode: 0o700 }); app.setAppLogsPath(layout.logs); }
  catch { /* The diagnostic writer exposes failure without blocking application startup. */ }
  // Chromium profile/cookies remain in userData. Only regenerable HTTP cache is relocated.
  app.commandLine.appendSwitch("disk-cache-dir", layout.cache);
  return layout;
}
