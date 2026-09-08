import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OAuthTokenRecord, OAuthTokenStore } from "@traceforge/server/model-settings";

interface Cipher { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
/** The cipher is supplied by Electron's OS-backed safeStorage, never renderer. */
export function createModelTokenStore(path: string, cipher: Cipher, maximumRecords = 32): OAuthTokenStore {
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 2048) throw new Error("Invalid secure store capacity");
  const validate = (record: OAuthTokenRecord) => {
    if (!record || typeof record !== "object" || typeof record.accessToken !== "string" || !record.accessToken || record.accessToken.length > 16384 ||
      (record.refreshToken !== undefined && (typeof record.refreshToken !== "string" || !record.refreshToken || record.refreshToken.length > 16384)) ||
      typeof record.binding !== "string" || record.binding.length > 16384 || !Number.isFinite(record.expiresAt)) throw new Error("Invalid model token store");
  };
  const read = (): Record<string, OAuthTokenRecord> => {
    if (!cipher.available()) throw new Error("Secure model storage unavailable");
    if (!existsSync(path)) return {};
    if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Model token store exceeds limit");
    const data = JSON.parse(cipher.decrypt(readFileSync(path)));
    if (!data || data.version !== 1 || !data.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts) || Object.keys(data.accounts).length > maximumRecords) throw new Error("Invalid model token store");
    for (const record of Object.values(data.accounts)) validate(record as OAuthTokenRecord);
    return data.accounts;
  };
  const save = (accounts: Record<string, OAuthTokenRecord>) => {
    if (!cipher.available()) throw new Error("Secure model storage unavailable");
    if (Object.keys(accounts).length > maximumRecords) throw new Error("Too many stored model accounts");
    const encrypted = cipher.encrypt(JSON.stringify({ version: 1, accounts }));
    if (encrypted.length > 4 * 1024 * 1024) throw new Error("Secure store capacity exceeded");
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" }); renameSync(temporary, path);
  };
  const identifier = (id: string) => { if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(id)) throw new Error("Invalid model account reference"); };
  return {
    async read(id) { identifier(id); const accounts = read(); return Object.hasOwn(accounts, id) ? structuredClone(accounts[id]) : undefined; },
    async write(id, record) { identifier(id); validate(record); save({ ...read(), [id]: record }); },
    async remove(id) { identifier(id); const accounts = read(); delete accounts[id]; save(accounts); },
  };
}
