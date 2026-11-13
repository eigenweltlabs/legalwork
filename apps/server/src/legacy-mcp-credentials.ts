import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import { withFileWriteLock } from "./file-write-lock.js";

// V1 stores expiry in seconds; native credentials store milliseconds. Pending
// OAuth state/PKCE is deliberately not a completed login and is not imported.
const legacyEntry = z.object({
  serverUrl: z.string().url(),
  tokens: z.object({ accessToken: z.string().min(1), refreshToken: z.string().optional(), expiresAt: z.number().nonnegative().optional(), scope: z.string().optional() }),
  clientInfo: z.object({ clientId: z.string(), clientSecret: z.string().optional(), clientIdIssuedAt: z.number().optional(), clientSecretExpiresAt: z.number().optional() }).optional(),
});
const receiptSchema = z.object({ version: z.literal(1), completed: z.array(z.string()) });
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function legacyMcpAuthPath() {
  return join(process.env.LEGALWORK_ENGINE_DATA_HOME?.trim() || process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode", "mcp-auth.json");
}
function identity(sourcePath: string, name: string, serverUrl: string) {
  const integrationID = "mcp_" + createHash("sha1").update(name + "\0" + serverUrl).digest("hex").slice(0, 16);
  return { integrationID, id: "cred_legalwork_mcp_" + hash(sourcePath + "\0" + integrationID) };
}

export async function legacyMcpCredentialImportPending(sourcePath: string, receiptPath: string) {
  const source = await readFile(sourcePath, "utf8").catch(error => { if (missing(error)) return undefined; throw error; });
  if (source === undefined) return false;
  const entries = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
  const completed: string[] = await readFile(receiptPath, "utf8").then(value => receiptSchema.parse(JSON.parse(value)).completed, error => { if (missing(error)) return []; throw error; });
  return Object.entries(entries).some(([name, value]) => {
    const entry = legacyEntry.safeParse(value);
    return entry.success && !completed.includes(identity(sourcePath, name, entry.data.serverUrl).id);
  });
}

/** Startup-only import through the native credential API. The original file
 * and immutable private snapshot survive; a receipt prevents later sign-outs
 * from being undone by an old auth file. Existing V2 logins always win. */
export async function migrateLegacyMcpCredentials(client: OpenCodeClient, sourcePath: string, receiptPath: string) {
  return withFileWriteLock(receiptPath, async () => {
    const source = await readFile(sourcePath, "utf8").catch(error => { if (missing(error)) return undefined; throw error; });
    if (source === undefined) return { imported: 0, retained: 0 };
    const entries = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
    const receipt = await readFile(receiptPath, "utf8").then(value => receiptSchema.parse(JSON.parse(value)), error => {
      if (missing(error)) return receiptSchema.parse({ version: 1, completed: [] });
      throw error;
    });
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    const archive = join(dirname(receiptPath), `mcp-auth-${hash(source)}.json`);
    try { await writeFile(archive, source, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await readFile(archive, "utf8") !== source) throw new Error("The preserved MCP login archive has changed.");
    }
    const credentials = await client.credential.list();
    let imported = 0, retained = 0;
    for (const [name, value] of Object.entries(entries)) {
      const parsed = legacyEntry.safeParse(value);
      if (!parsed.success) { retained++; continue; }
      const entry = parsed.data;
      // This identity is the pinned engine's native name+URL binding. Keeping
      // the full URL (not just its origin) prevents cross-connector token reuse.
      const { integrationID, id } = identity(sourcePath, name, entry.serverUrl);
      if (receipt.completed.includes(id)) continue;
      if (!credentials.some(credential => credential.integrationID === integrationID)) {
        const info = entry.clientInfo;
        await client.credential.create({ id, integrationID, label: name, value: {
          type: "oauth", methodID: integrationID, access: entry.tokens.accessToken, refresh: entry.tokens.refreshToken ?? "",
          expires: entry.tokens.expiresAt === undefined ? 0 : Math.round(entry.tokens.expiresAt * 1000),
          metadata: { serverUrl: entry.serverUrl, tokenType: "Bearer", ...(entry.tokens.scope ? { scope: entry.tokens.scope } : {}),
            ...(info ? { client: { client_id: info.clientId, ...(info.clientSecret === undefined ? {} : { client_secret: info.clientSecret }),
              ...(info.clientIdIssuedAt === undefined ? {} : { client_id_issued_at: info.clientIdIssuedAt }),
              ...(info.clientSecretExpiresAt === undefined ? {} : { client_secret_expires_at: info.clientSecretExpiresAt }) } } : {}) },
        } });
        imported++;
      }
      receipt.completed.push(id);
      const temporary = `${receiptPath}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, receiptPath); }
      finally { await rm(temporary, { force: true }); }
    }
    return { imported, retained };
  });
}
