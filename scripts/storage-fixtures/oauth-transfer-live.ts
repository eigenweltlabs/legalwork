/** Opt-in large-file verification against a real account; synthetic data only. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storageInputSchema } from "../../apps/server/src/file-storage/schema.js";
import { StorageOAuth, tokenBindings } from "../../apps/server/src/file-storage/oauth/session.js";
import { oauthProvider } from "../../apps/server/src/file-storage/oauth/providers.js";
const directory = process.env.LEGALWORK_OAUTH_TEST_DIR;
if (!directory) throw new Error("Set LEGALWORK_OAUTH_TEST_DIR outside the repository and sign in with oauth-live.ts first.");
await mkdir(directory, { recursive: true, mode: 0o700 });
const digest = async (path: string) => { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); };
for (const provider of process.argv.slice(2)) {
  const input = storageInputSchema.parse({ name: "OAuth verification", config: { kind: "oauth", provider, root: process.env.LEGALWORK_OAUTH_TEST_ROOT ?? "" } });
  const oauth = new StorageOAuth(resolve(directory, "test.vault")); oauth.bind("verification", provider, input);
  const token = tokenBindings.get(input);
  if (!token || input.config.kind !== "oauth") throw new Error("Sign in first");
  const adapter = await oauthProvider(provider).adapter(input.config, token);
  const root = `LegalWork transfer verification ${Date.now()}`;
  const source = resolve(directory, `${provider}-large-source.bin`);
  const destination = resolve(directory, `${provider}-large-download-${Date.now()}.bin`);
  await writeFile(source, Buffer.alloc(65 * 1024 * 1024, 71), { mode: 0o600 });
  try {
    await adapter.mkdir(root);
    await adapter.upload(`${root}/synthetic-65MiB.bin`, source, "application/octet-stream", { createOnly: true });
    const file = (await adapter.list(root)).entries.find((entry) => entry.name === "synthetic-65MiB.bin");
    if (!file) throw new Error("Large upload missing from folder");
    await adapter.download(file.path, destination);
    if (await digest(source) !== await digest(destination)) throw new Error("Large download checksum mismatch");
    console.log(`${provider}: 65 MiB upload and download checksum passed`);
  } finally { await adapter.close?.(); }
}
