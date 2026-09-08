import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createModelTokenStore } from "./model-token-store.js";
let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
it("persists encrypted credentials, reopens and removes only the chosen account", async () => {
  dir = mkdtempSync(join(tmpdir(), "traceforge-token-store-")); const path = join(dir, "tokens.bin"); const key = randomBytes(32);
  const cipher = { available: () => true, encrypt(value: string) { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    decrypt(value: Buffer) { const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); c.setAuthTag(value.subarray(-16)); return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]).toString(); } };
  const store = createModelTokenStore(path, cipher); const record = { accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 123456, binding: "connection" };
  await store.write("first", record); await store.write("second", record);
  expect(readFileSync(path).includes(Buffer.from("private-access"))).toBe(false);
  const reopened = createModelTokenStore(path, cipher); expect(await reopened.read("first")).toEqual(record);
  await reopened.remove("first"); expect(await store.read("first")).toBeUndefined(); expect(await store.read("second")).toEqual(record);
  const before = readFileSync(path);
  await expect(createModelTokenStore(path, { ...cipher, available: () => false }).write("third", record)).rejects.toThrow();
  expect(readFileSync(path)).toEqual(before);
  writeFileSync(path, "corrupt"); await expect(store.write("first", record)).rejects.toThrow(); expect(readFileSync(path, "utf8")).toBe("corrupt");
});
