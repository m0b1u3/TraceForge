// Electron and Node have different native ABIs. Restore the workspace's Node
// binding after desktop development before running ordinary Node tests.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const cwd = dirname(require.resolve("better-sqlite3/package.json"));
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "install"], { cwd, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
