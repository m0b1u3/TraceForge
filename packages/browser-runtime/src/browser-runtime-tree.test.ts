import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureBrowserRuntimeTree } from "./browser-runtime-tree.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Browser Runtime installation tree measurement", () => {
  it("binds files, executable modes, directories and contained symbolic links deterministically", async () => {
    const root = await fixture();
    const first = await measureBrowserRuntimeTree(root);
    const second = await measureBrowserRuntimeTree(root);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ entries: 4, bytes: 15 });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(join(root, "bin", "chrome"), "changed", "utf8");
    expect((await measureBrowserRuntimeTree(root)).sha256).not.toBe(first.sha256);
  });

  it("fails closed on capacity overflow and symbolic links outside the reviewed root", async () => {
    const root = await fixture();
    await expect(measureBrowserRuntimeTree(root, { maximumEntries: 1 })).rejects.toThrow("entry limit");
    await expect(measureBrowserRuntimeTree(root, { maximumBytes: 1 })).rejects.toThrow("byte limit");
    await symlink("../../outside", join(root, "escape"));
    await expect(measureBrowserRuntimeTree(root)).rejects.toThrow(/escapes|realpath/);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "traceforge-browser-tree-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "chrome"), "browser", { encoding: "utf8", mode: 0o755 });
  await writeFile(join(root, "resources.dat"), "resource", "utf8");
  await symlink("../resources.dat", join(root, "bin", "resources-current"));
  return root;
}
