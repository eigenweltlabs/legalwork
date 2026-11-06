import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { z } from "zod";
import { withFileWriteLock } from "./file-write-lock.js";

const legacyValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api"), key: z.string(), metadata: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("oauth"), access: z.string(), refresh: z.string(), expires: z.number().int().nonnegative(), accountId: z.string().optional(), enterpriseUrl: z.string().optional() }),
]);

const legacyIntegrationIDs = new Map([
  ["azure-cognitive-services", "azure"],
  ["google-vertex-anthropic", "google-vertex"],
]);

async function openReceipt(path: string) {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: false });
    return { run: (sql: string) => { db.run(sql); }, has: (sql: string) => Boolean(db.query(sql).get()), close: () => db.close() };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  return { run: (sql: string) => { db.exec(sql); }, has: (sql: string) => Boolean(db.prepare(sql).get()), close: () => db.close() };
}

async function importRetiredProviderCredentials(client: OpenCodeClient) {
  const credentials = await client.credential.list();
  for (const [retired, integrationID] of legacyIntegrationIDs) {
    // Native v1 upgrades already copied these credentials under the old IDs.
    // Keep those originals and use stable copy IDs to resume interrupted imports.
    const imported = credentials.filter(item => item.integrationID === retired).map(item => ({
      id: `${item.id}_legalwork_provider`, integrationID, label: item.label, value: item.value, activate: item.active,
    }));
    const copyIDs = new Set(imported.map(item => item.id));
    const existing = credentials.filter(item => item.integrationID === integrationID);
    // A current account saved independently of this import always wins.
    if (existing.some(item => !copyIDs.has(item.id))) continue;
    // The first credential is selected by the native API even with activate:false.
    // Import the selected account last to preserve the original selection.
    for (const item of imported.sort((a, b) => Number(a.activate) - Number(b.activate))) {
      if (!existing.some(current => current.id === item.id)) await client.credential.create(item);
    }
  }
}

/** OpenCode 2.1.4 marks every migration complete on a fresh database without
 * running its auth.json importer. Complete both the native v1 import's provider
 * ID mapping and the fresh-database import once, using native credential APIs.
 * Never use the legacy file as a continuing authentication fallback.
 * The receipt lives with the database, including across backup/restore. */
export async function importLegacyProviderCredentials(client: OpenCodeClient, options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = { ...process.env, ...options.env };
  if (!env.OPENCODE_DB) return;
  const database = resolve(options.cwd, env.OPENCODE_DB);
  // Match the engine's XDG roots. OPENCODE_TEST_HOME does not change global.data.
  const profileHome = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const source = join(env.XDG_DATA_HOME || join(profileHome, ".local", "share"), "opencode", "auth.json");
  await withFileWriteLock(database, async () => {
    const db = await openReceipt(database);
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.run("CREATE TABLE IF NOT EXISTS _legalwork_legacy_provider_import (id INTEGER PRIMARY KEY CHECK (id = 1))");
      if (db.has("SELECT id FROM _legalwork_legacy_provider_import WHERE id = 1")) return;
      await importRetiredProviderCredentials(client);
      // A v1 upgrade ran the native importer. Do not reread auth.json and revive
      // credentials removed after that upgrade. Fresh v2 has only session_v2.
      const upgraded = db.has("SELECT name FROM sqlite_master WHERE type='table' AND name='session'");
      if (!upgraded) {
        let content: string | undefined;
        try { content = await readFile(source, "utf8"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("Could not read saved provider connections for migration."); }
        if (content !== undefined) {
          let entries: Record<string, unknown>;
          try { entries = z.record(z.string(), z.unknown()).parse(JSON.parse(content)); }
          catch { throw new Error("Saved provider connections could not be migrated: the legacy file is invalid."); }
          const existing = new Set((await client.credential.list()).map(item => item.integrationID));
          // Prefer an explicitly saved current connection over its retired alias.
          const ordered = Object.entries(entries).map(([id, raw]) => ({ id: id.replace(/\/+$/, ""), raw }))
            .sort((a, b) => Number(legacyIntegrationIDs.has(a.id)) - Number(legacyIntegrationIDs.has(b.id)));
          for (const { id, raw } of ordered) {
            const integrationID = legacyIntegrationIDs.get(id) ?? id, parsed = legacyValue.safeParse(raw);
            if (!integrationID || !parsed.success || existing.has(integrationID)) continue;
            const value = parsed.data;
            const credential: Parameters<OpenCodeClient["credential"]["create"]>[0]["value"] = value.type === "api"
              ? { type: "key", key: value.key, metadata: value.metadata }
              : { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires,
                  methodID: integrationID === "openai" ? "chatgpt-browser" : ["github-copilot", "opencode", "xai"].includes(integrationID) ? "device" : "oauth",
                  metadata: { ...(value.accountId ? { accountID: value.accountId } : {}), ...(value.enterpriseUrl ? { enterpriseUrl: value.enterpriseUrl } : {}) } };
            await client.credential.create({ integrationID, value: credential, label: value.type === "api" ? "API key" : "OAuth", activate: true });
            existing.add(integrationID);
          }
        }
      }
      db.run("INSERT INTO _legalwork_legacy_provider_import (id) VALUES (1)");
    } finally { db.close(); }
  });
}
