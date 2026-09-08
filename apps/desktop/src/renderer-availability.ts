import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
/** Refuse missing assets instead of falling back to the retired Web renderer. */
export function requireDesktopRenderer(root: string): void {
  if (!isAbsolute(root) || !existsSync(join(root, "index.html"))) throw new Error("桌面界面尚未构建，请先构建 desktop renderer。");
}
