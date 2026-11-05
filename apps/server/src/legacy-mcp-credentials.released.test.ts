import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { legacyMcpCredentialImportPending, migrateLegacyMcpCredentials } from "./legacy-mcp-credentials.js";

test.skipIf(!nativeMcpBinary)("all six v1 MCP logins retain URL binding, refresh/client metadata, newer v2 logins and intentional disconnection", async () => {
  const engine = await nativeMcpEngine({});
  try {
    const sourcePath = join(engine.root, "mcp-auth.json"), receipt = join(engine.root, "import", "receipt.json");
    const entries = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`connector-${index}`, {
      serverUrl: `https://example.invalid/${index}/mcp`, tokens: { accessToken: `synthetic-access-${index}`, refreshToken: `synthetic-refresh-${index}`, expiresAt: 1_900_000_000, scope: "read files" },
      clientInfo: { clientId: `client-${index}`, clientSecret: `synthetic-secret-${index}`, clientIdIssuedAt: 1_800_000_000, clientSecretExpiresAt: 0 },
    }]));
    const original = JSON.stringify({ ...entries, "unfinished-login": { oauthState: "synthetic-pending" } });
    await writeFile(sourcePath, original, { mode: 0o600 });
    expect(await legacyMcpCredentialImportPending(sourcePath, receipt)).toBe(true);
    const existingID = "mcp_" + createHash("sha1").update("connector-0\0https://example.invalid/0/mcp").digest("hex").slice(0, 16);
    await engine.client().credential.create({ integrationID: existingID, value: { type: "oauth", methodID: existingID, access: "synthetic-newer-v2", refresh: "synthetic-newer-refresh", expires: 0 } });
    expect(await migrateLegacyMcpCredentials(engine.client(), sourcePath, receipt)).toEqual({ imported: 5, retained: 1 });
    expect(await legacyMcpCredentialImportPending(sourcePath, receipt)).toBe(false);
    const saved = await engine.client().credential.list();
    expect(saved).toHaveLength(6);
    expect(saved.find(item => item.integrationID === existingID)?.value).toMatchObject({ access: "synthetic-newer-v2" });
    for (let index = 1; index < 6; index++) {
      const entry = saved.find(item => item.label === `connector-${index}`);
      expect(entry?.value).toMatchObject({ access: `synthetic-access-${index}`, refresh: `synthetic-refresh-${index}`, expires: 1_900_000_000_000,
        metadata: { serverUrl: `https://example.invalid/${index}/mcp`, scope: "read files", client: { client_id: `client-${index}`, client_secret: `synthetic-secret-${index}`, client_id_issued_at: 1_800_000_000, client_secret_expires_at: 0 } } });
    }
    await engine.restart();
    expect(await engine.client().credential.list()).toEqual(saved);
    const removed = saved.find(item => item.label === "connector-1");
    if (!removed) throw new Error("Missing imported connector");
    await engine.client().credential.remove({ credentialID: removed.id });
    expect(await migrateLegacyMcpCredentials(engine.client(), sourcePath, receipt)).toEqual({ imported: 0, retained: 1 });
    expect((await engine.client().credential.list()).some(item => item.id === removed.id)).toBe(false);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    const archive = (await readdir(join(engine.root, "import"))).find(name => name.startsWith("mcp-auth-"));
    expect(await readFile(join(engine.root, "import", archive!), "utf8")).toBe(original);
  } finally { await engine.close(); }
}, 30_000);
