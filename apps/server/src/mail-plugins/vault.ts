import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { mailAccountSchema } from "./schema.js";
import { ApiError } from "../errors.js";
import { vaultLock } from "../file-storage/oauth/vault.js";

const account = mailAccountSchema.extend({ clientId: z.string(), scopes: z.array(z.string()), accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() });
export type SavedMailAccount = z.infer<typeof account>;
const send = z.object({ digest: z.string(), state: z.enum(["sending", "sent", "uncertain"]), createdAt: z.string() });
const contents = z.object({ accounts: z.array(account), sends: z.record(z.string(), send), grants: z.record(z.string(), z.array(z.string())).default({}) });
type Contents = z.infer<typeof contents>;
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Desktop-profile credentials and send receipts stay outside portable workspace config. */
export class MailPluginVault {
  constructor(readonly path: string) {}
  private async key() {
    if (process.env.LEGALWORK_ENCRYPTION_KEY) return createHash("sha256").update(process.env.LEGALWORK_ENCRYPTION_KEY).digest();
    const path = `${this.path}.key`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { return await readFile(path); } catch (error) { if (!absent(error)) throw error; }
    try { await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    return readFile(path);
  }
  async read(): Promise<Contents> {
    let data: Buffer;
    try { data = await readFile(this.path); } catch (error) { if (absent(error)) return { accounts: [], sends: {}, grants: {} }; throw error; }
    try {
      const decipher = createDecipheriv("aes-256-gcm", await this.key(), data.subarray(0, 12));
      decipher.setAAD(Buffer.from("legalwork-mail-plugins-v1"));
      decipher.setAuthTag(data.subarray(12, 28));
      return contents.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()));
    } catch { throw new ApiError(500, "mail_credentials_unreadable", "Saved email connections could not be opened. Restore the app encryption key before reconnecting."); }
  }
  async update<T>(operation: (value: Contents) => T | Promise<T>): Promise<T> {
    return vaultLock(this.path, async () => {
      const value = await this.read();
      const result = await operation(value);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
      cipher.setAAD(Buffer.from("legalwork-mail-plugins-v1"));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), bytes]), { mode: 0o600 });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return result;
    });
  }
}
