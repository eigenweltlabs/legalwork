import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageOAuth, tokenBindings } from "./session.js";
import { oauthProviders, type OAuthProvider } from "./providers.js";
import { OAuthVault } from "./vault.js";
import { storageInputSchema } from "../schema.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() { const directory = await mkdtemp(join(tmpdir(), "storage-oauth-test-")); directories.push(directory); return join(directory, "oauth.vault"); }
test("vault encrypts tokens, rejects tampering and serializes updates", async () => {
  const path = await setup(); const vault = new OAuthVault(path);
  await Promise.all([vault.set("a", { accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 123 }), vault.set("b", { accessToken: "b", refreshToken: "b", expiresAt: 123 })]);
  expect((await readFile(path)).includes(Buffer.from("private-access"))).toBe(false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await vault.get("a"))?.refreshToken).toBe("private-refresh");
  expect((await vault.get("b"))?.accessToken).toBe("b");
  await vault.set("a"); expect(await vault.get("a")).toBeUndefined();
});
test("PKCE callback validates state, persists locally, and disconnect closes access", async () => {
  let exchanges = 0;
  const tokenServer = Bun.serve({ port: 0, fetch: async (request) => {
    exchanges++; const fields = await request.formData();
    expect(fields.get("code_verifier")?.toString().length).toBeGreaterThan(42);
    expect(fields.get("client_secret")).toBeNull();
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  } });
  const provider: OAuthProvider = { id: "test-oauth", name: "Test", rootHint: "", clientId: "public", authorizeUrl: "https://example.com/authorize", tokenUrl: `http://localhost:${tokenServer.port}/token`, scopes: () => ["files.read"], adapter: () => { throw new Error("unused"); } };
  oauthProviders.push(provider);
  const oauth = new StorageOAuth(await setup());
  const input = storageInputSchema.parse({ name: "Test", config: { kind: "oauth", provider: provider.id } });
  const key = oauth.key("workspace", "connection", input);
  try {
    const start = await oauth.start(key, input, async () => true);
    const auth = new URL(start.authUrl);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: "wrong", code: "code" }).toString();
    expect((await fetch(callback)).status).toBe(400); expect(exchanges).toBe(0);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    expect((await fetch(callback)).status).toBe(200);
    expect(await oauth.status(key)).toEqual({ connected: true, pending: false });
    oauth.bind("workspace", "connection", input);
    expect(await tokenBindings.get(input)!()).toBe("access");
    await oauth.disconnect(key);
    await expect(tokenBindings.get(input)!()).rejects.toThrow("Sign in");
  } finally { await oauth.disconnect(key); tokenServer.stop(true); oauthProviders.splice(oauthProviders.indexOf(provider), 1); }
});
test("removed connection cannot accept an otherwise valid callback", async () => {
  const tokenServer = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "a", refresh_token: "r" }) });
  const provider: OAuthProvider = { id: "test-removed", name: "Test", rootHint: "", clientId: "public", authorizeUrl: "https://example.com/authorize", tokenUrl: `http://localhost:${tokenServer.port}`, scopes: () => [], adapter: () => { throw new Error("unused"); } };
  oauthProviders.push(provider); const oauth = new StorageOAuth(await setup());
  const input = storageInputSchema.parse({ name: "Test", config: { kind: "oauth", provider: provider.id } });
  const key = oauth.key("w", "c", input);
  try {
    const url = new URL((await oauth.start(key, input, async () => false)).authUrl);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "x", state: url.searchParams.get("state")! }).toString();
    expect((await fetch(callback)).status).toBe(400);
    expect((await oauth.status(key)).connected).toBe(false);
  } finally { await oauth.disconnect(key); tokenServer.stop(true); oauthProviders.splice(oauthProviders.indexOf(provider), 1); }
});
