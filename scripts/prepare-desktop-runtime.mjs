import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builder = createRequire(desktop.resolve("electron-builder"));
const appBuilder = createRequire(builder.resolve("app-builder-lib"));
const { rebuild } = await import(pathToFileURL(appBuilder.resolve("@electron/rebuild")).href);
// Node restoration replaces the binary without invalidating electron/rebuild's
// marker. Force rebuilding prevents a stale marker from accepting the wrong ABI.
await rebuild({ buildPath: fileURLToPath(new URL("../apps/desktop", import.meta.url)),
  electronVersion: desktop("electron/package.json").version, force: true, onlyModules: ["better-sqlite3"] });
