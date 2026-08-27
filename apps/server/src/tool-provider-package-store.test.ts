import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()!;
    makeTreeWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "traceforge-provider-package-"));
  temporaryDirectories.push(directory);
  const source = join(directory, "source");
  const managed = join(directory, "managed");
  mkdirSync(join(source, "support"), { recursive: true });
  writeFileSync(join(source, "provider.bin"), "provider executable");
  chmodSync(join(source, "provider.bin"), 0o700);
  writeFileSync(join(source, "support", "metadata.json"), "{}");
  return { directory, source, managed };
}

function makeTreeWritable(root: string): void {
  if (!existsSync(root)) return;
  const stats = lstatSync(root);
  chmodSync(root, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(root)) makeTreeWritable(join(root, name));
}

describe("ManagedToolProviderPackageStore", () => {
  it("publishes a deterministic immutable copy outside the import source", () => {
    const context = fixture();
    const store = new ManagedToolProviderPackageStore(context.managed);
    const inventory = inspectToolProviderPackage(context.source);
    const published = store.publish(context.source, "neutral-provider", "1.0.0", inventory.digest);

    expect(published.startsWith(store.root)).toBe(true);
    expect(inspectToolProviderPackage(published)).toEqual(inventory);
    writeFileSync(join(context.source, "provider.bin"), "changed import source");
    expect(readFileSync(join(published, "provider.bin"), "utf8")).toBe("provider executable");
    if (process.platform !== "win32") {
      expect(lstatSync(published).mode & 0o222).toBe(0);
      expect(lstatSync(join(published, "provider.bin")).mode & 0o222).toBe(0);
    }
  });

  it("rejects packages that exceed configured limits without publishing a version", () => {
    const context = fixture();
    const store = new ManagedToolProviderPackageStore(context.managed, { maximumFiles: 1, maximumBytes: 1024 });
    expect(() => store.publish(context.source, "neutral-provider", "1.0.0", "0".repeat(64)))
      .toThrow(/exceeds 1 files/);
    expect(readdirSync(store.root)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("rejects symbolic links before import", () => {
    const context = fixture();
    symlinkSync("provider.bin", join(context.source, "alias.bin"));
    const store = new ManagedToolProviderPackageStore(context.managed);
    expect(() => store.inspect(context.source)).toThrow(/symbolic link alias\.bin/);
    expect(readdirSync(store.root)).toEqual([]);
  });
});
