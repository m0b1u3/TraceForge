import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StorageLayout { root: string; logs: string; cache: string; channel: "production" | "development" | "isolated"; legacy: boolean }
const containsData = (root: string) => ["traceforge.sqlite", "config/llm.json", "config/llm-secrets.bin", "desktop-journal.json"].some(name => existsSync(join(root, name)));

/** Preserve existing state in place; never merge two independent databases. */
export function storageLayout(input: { appData: string; home: string; current: string; appName: string; packaged: boolean; platform: string }): StorageLayout {
  const { appData, home, current, appName, packaged, platform } = input;
  const name = packaged ? "TraceForge" : "TraceForge-Dev";
  const canonical = join(appData, name);
  // Native acceptance explicitly sets userData before importing the entry point.
  const isolated = resolve(current) !== resolve(join(appData, appName)) && resolve(current) !== resolve(canonical);
  if (isolated) return { root: current, logs: join(current, "logs"), cache: join(current, "cache"), channel: "isolated", legacy: false };
  const legacy = packaged ? [] : [join(appData, "@traceforge", "desktop"), join(appData, "Electron"), current]
    .filter(path => resolve(path) !== resolve(join(appData, "TraceForge")));
  const populated = [...new Set([canonical, ...legacy])].filter(containsData);
  if (populated.length > 1) throw new Error("发现两个独立的 TraceForge 数据目录。为避免覆盖记录，请先备份并明确选择保留的数据目录。");
  const root = populated[0] ?? canonical;
  return { root, logs: platform === "darwin" ? join(home, "Library", "Logs", name) : join(canonical, "logs"),
    cache: platform === "darwin" ? join(home, "Library", "Caches", name) : join(canonical, "cache"),
    channel: packaged ? "production" : "development", legacy: root !== canonical };
}
