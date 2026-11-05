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

/** OpenCode 2.1.4 marks every migration complete on a fresh database without
 * running its auth.json importer. Repair that path once, using native credential
 * APIs; never use the legacy file as a continuing authentication fallback.
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
      // A v1 upgrade ran the native importer. Do not revive credentials removed
      // after that upgrade. Fresh v2 schemas contain only session_v2.
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
          for (const [id, raw] of Object.entries(entries)) {
            const integrationID = id.replace(/\/+$/, ""), parsed = legacyValue.safeParse(raw);
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
