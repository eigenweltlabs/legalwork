import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ApiError } from "../../errors.js";

const credential = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() });
export type Credential = z.infer<typeof credential>;
const records = z.record(z.string(), credential);
const locks = new Map<string, Promise<unknown>>();
export async function vaultLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export class OAuthVault {
  constructor(readonly path: string) {}
  private async key() {
    if (process.env.LEGALWORK_ENCRYPTION_KEY)
      return createHash("sha256").update(process.env.LEGALWORK_ENCRYPTION_KEY).digest();
    const path = `${this.path}.key`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { return await readFile(path); } catch (error) { if (!absent(error)) throw error; }
    try { await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    return readFile(path);
  }
  private async all(): Promise<z.infer<typeof records>> {
    let data: Buffer;
    try { data = await readFile(this.path); } catch (error) { if (absent(error)) return {}; throw error; }
    try {
      const decipher = createDecipheriv("aes-256-gcm", await this.key(), data.subarray(0, 12));
      decipher.setAAD(Buffer.from("legalwork-storage-oauth-v1"));
      decipher.setAuthTag(data.subarray(12, 28));
      return records.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()));
    } catch {
      throw new ApiError(500, "storage_signin_unreadable", "Saved sign-ins could not be opened. Restore the app encryption key before reconnecting.");
    }
  }
  async get(id: string) { return (await this.all())[id]; }
  async set(id: string, value?: Credential) {
    return vaultLock(this.path, async () => {
      const all = await this.all();
      if (value) all[id] = value; else delete all[id];
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
      cipher.setAAD(Buffer.from("legalwork-storage-oauth-v1"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(all)), cipher.final()]);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
      await rename(temporary, this.path);
    });
  }
}
