/** Explicit manual smoke test against a real signed-in provider, using synthetic files only. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storageInputSchema } from "../../apps/server/src/file-storage/schema.js";
import { StorageOAuth, tokenBindings } from "../../apps/server/src/file-storage/oauth/session.js";
import { oauthProvider } from "../../apps/server/src/file-storage/oauth/providers.js";

const providerId = process.argv[2];
if (!providerId) throw new Error("Pass the provider id.");
const directory = process.env.LEGALWORK_OAUTH_TEST_DIR;
if (!directory) throw new Error("Set LEGALWORK_OAUTH_TEST_DIR to a private directory outside this repository.");
await mkdir(directory, { recursive: true, mode: 0o700 });
const input = storageInputSchema.parse({ name: "OAuth verification", config: { kind: "oauth", provider: providerId } });
const oauth = new StorageOAuth(resolve(directory, "test.vault"));
const key = oauth.key("verification", providerId, input);
if (!(await oauth.status(key)).connected) {
  const flow = await oauth.start(key, input, async () => true);
  console.log(flow.authUrl);
  const deadline = Date.now() + 5 * 60_000;
  while (!(await oauth.status(key)).connected) {
    const status = await oauth.status(key);
    if (status.error || Date.now() > deadline) throw new Error(status.error ?? "Sign-in timed out");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
oauth.bind("verification", providerId, input);
const token = tokenBindings.get(input);
if (!token || input.config.kind !== "oauth") throw new Error("Missing sign-in");
const adapter = await oauthProvider(providerId).adapter(input.config, token);
const root = `LegalWork OAuth Review ${Date.now()}`;
const file = `${root}/matter-1001-00008.txt`;
const original = Buffer.from("Synthetic OAuth verification. Matter 1001-00008. Drafting a lease.\n");
try {
  await adapter.mkdir(root);
  await adapter.write(file, original, "text/plain", { createOnly: true });
  const listing = await adapter.list(root);
  const item = listing.entries.find((entry) => entry.name === "matter-1001-00008.txt");
  if (!item) throw new Error("Uploaded file not listed");
  const read = await adapter.read(item.path);
  if (!read.data.equals(original)) throw new Error("Read differs from upload");
  await adapter.write(item.path, Buffer.from("Synthetic updated lease draft.\n"), "text/plain", { version: read.version });
  let conflict = false;
  try { await adapter.write(item.path, original, "text/plain", { version: read.version }); }
  catch (error) { conflict = error instanceof Error && "status" in error && error.status === 409; }
  if (!conflict) throw new Error("Stale save was not rejected");
  const local = resolve(directory, `${providerId}-download.txt`);
  await adapter.download(item.path, local);
  if (!(await readFile(local)).equals(Buffer.from("Synthetic updated lease draft.\n"))) throw new Error("Download differs");
  const capabilities = await adapter.searchCapabilities?.();
  if (!capabilities?.modes.includes("name") || !adapter.search) throw new Error("Native agent search unavailable");
  let found = false;
  for (let attempt = 0; attempt < 12 && !found; attempt++) {
    const search = await adapter.search({ query: "matter-1001-00008", mode: "name", path: root });
    found = search.entries.some((entry) => entry.path === item.path);
    if (!found) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!found) throw new Error("Search did not find the synthetic file after indexing wait");
  if (process.env.LEGALWORK_OAUTH_REVIEW_ICON)
    await adapter.upload(`${root}/legalwork-icon.png`, process.env.LEGALWORK_OAUTH_REVIEW_ICON, "image/png", { createOnly: true });
  const result = { provider: providerId, root, listing: true, upload: true, read: true, edit: true, conflict: true, download: true, search: true };
  await writeFile(resolve(directory, `${providerId}-result.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await adapter.close?.(); }
