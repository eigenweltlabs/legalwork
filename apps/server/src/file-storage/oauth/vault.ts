import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { StorageStore } from "../store.js";
import type { ServerConfig } from "../../types.js";

const credential = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() });
export type Credential = z.infer<typeof credential>;
// Keep each entry's schema at its consumer so OAuth grants and Nango
// connection capabilities share encryption without overwriting one another.
const records = z.record(z.string(), z.unknown());
type EntrySchema<T> = {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};
const locks = new Map<string, Promise<unknown>>();
export async function vaultLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
const vaultState = z.object({ version: z.literal(1), expected: z.boolean() }).strict();
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const unreadable = () => new ApiError(500, "storage_signin_unreadable", "Saved sign-ins could not be opened. Restore the app encryption key before reconnecting.");
export function oauthVaultPath(config: Pick<ServerConfig, "configPath">) {
  return join(dirname(new StorageStore(config).path), "storage-oauth.vault");
}
export class OAuthVault {
  constructor(readonly path: string) {}
  get statePath() { return `${this.path}.state.json`; }
  private async expected() {
    try { return vaultState.parse(JSON.parse(await readFile(this.statePath, "utf8"))).expected; }
    catch (error) { if (absent(error)) return undefined; throw unreadable(); }
  }
  private async remember(expected: boolean) {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, expected }), { mode: 0o600 });
      await rename(temporary, this.statePath);
    } finally { await rm(temporary, { force: true }); }
  }
  async prepared() { return (await this.expected()) !== undefined; }
  /** Explicit startup transition for existing current-format vaults. */
  async prepare() {
    await vaultLock(this.path, async () => {
      await this.all();
      const expected = await this.expected();
      let exists = true;
      try { await readFile(this.path); } catch (error) { if (!absent(error)) throw error; exists = false; }
      if (expected === undefined || exists && !expected) await this.remember(exists);
    });
  }
  /** Names only, for an explicit startup import; never credential values. */
  async entryNames<T>(schema: EntrySchema<T>, matches: (id: string) => boolean) {
    const names = [];
    for (const [id, value] of Object.entries(await this.all())) {
      if (!matches(id)) continue;
      if (!schema.safeParse(value).success) throw unreadable();
      names.push(id);
    }
    return names;
  }
  private async key(create = true) {
    if (process.env.LEGALWORK_ENCRYPTION_KEY)
      return createHash("sha256").update(process.env.LEGALWORK_ENCRYPTION_KEY).digest();
    const path = `${this.path}.key`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { return await readFile(path); } catch (error) { if (!absent(error)) throw error; if (!create) throw unreadable(); }
    try { await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    return readFile(path);
  }
  private async all(): Promise<z.infer<typeof records>> {
    let data: Buffer;
    try { data = await readFile(this.path); } catch (error) {
      if (!absent(error)) throw error;
      if (await this.expected()) throw new ApiError(503, "storage_signin_missing", "The established sign-in vault is missing. Restore the original vault instead of reconnecting over it.");
      return {};
    }
    try {
      if (data.length < 28) throw unreadable();
      const decipher = createDecipheriv("aes-256-gcm", await this.key(false), data.subarray(0, 12));
      decipher.setAAD(Buffer.from("legalwork-storage-oauth-v1"));
      decipher.setAuthTag(data.subarray(12, 28));
      return records.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()));
    } catch {
      throw unreadable();
    }
  }
  async ready() {
    await vaultLock(this.path, async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await this.all();
      if ((await this.key()).length !== 32) throw unreadable();
    });
  }
  async getEntry<T>(id: string, schema: EntrySchema<T>): Promise<T | undefined> {
    const value = (await this.all())[id];
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);
    if (!result.success) throw unreadable();
    return result.data;
  }
  async get(id: string) { return this.getEntry(id, credential); }
  async set(id: string, value?: Credential, isCurrent?: () => boolean) { return this.setEntry(id, credential, value, isCurrent); }
  async setEntry<T>(id: string, schema: EntrySchema<T>, value?: T, isCurrent?: () => boolean): Promise<boolean> {
    return vaultLock(this.path, async () => {
      if (isCurrent && !isCurrent()) return false;
      const all = await this.all();
      if (value !== undefined) all[id] = schema.parse(value); else delete all[id];
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
      cipher.setAAD(Buffer.from("legalwork-storage-oauth-v1"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(all)), cipher.final()]);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
        if (isCurrent && !isCurrent()) return false;
        await this.remember(true);
        await rename(temporary, this.path);
        return true;
      } finally { await rm(temporary, { force: true }); }
    });
  }
}
