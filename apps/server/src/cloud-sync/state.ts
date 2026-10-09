import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import constants from "../../../../constants.json" with { type: "json" };
import { ApiError } from "../errors.js";
import { localSessionDatabasePath } from "../content-search.js";
import { openSqliteReadonly, MANAGED_ENGINE_DB_FILENAME } from "../managed-opencode-db.js";
import { openSqlite, runtimeDbPath, type Row, type SqlValue } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { projectSyncStore } from "../project-sync-store.js";
import { readProjectDetails, restoreProjectDetails } from "../project-store.js";
import { CheckpointSchema, type Checkpoint, type SyncProject } from "./schema.js";
import { getBlob, putBlob, type SyncObjects } from "./objects.js";

// Only application data. Tokens, provider/connector accounts, calendar feed
// secrets, machine cursors, transfer bases and derived caches stay on-device.
export const RUNTIME_TABLES = new Set([
  "runtime_opencode_configs", "session_group_states", "session_usage_limits", "project_links",
  "assistant_days", "assistant_profiles", "assistant_onboarding", "assistant_greeting_views", "assistant_project_defaults",
  "assistant_session_queue", "assistant_delegations", "assistant_delegation_receipts", "assistant_attention_cards", "assistant_attention_widgets",
  "channel_runtime_owner", "channel_runtime_jobs", "channel_runtime_conversations", "channel_runtime_commands", "channel_runtime_approvals", "channel_runtime_settings",
  "scheduled_tasks", "scheduled_task_runs", "scheduled_task_defaults", "scheduled_sessions",
  "tasks", "task_projects", "task_sessions", "task_notes", "task_attachments", "task_flags", "task_text_conflicts", "task_notifications",
  "calendar_items", "calendar_history", "deadline_calculations", "calculation_runs", "calculation_presentations", "calendar_conflicts", "calendar_reminders",
]);
export const ENGINE_TABLES = new Set(["project", "workspace", "session", "message", "part", "todo", "permission", "migration", "__drizzle_migrations"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const PORTABLE_CONFIG_FIELDS = new Set(["default_agent", "disabled_providers", "permission", "personalization", "agent"]);

export function portableConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const config = Object.fromEntries(Object.entries(value).filter(([key]) => PORTABLE_CONFIG_FIELDS.has(key)));
  if (isRecord(config.agent)) config.agent = Object.fromEntries(Object.entries(config.agent).flatMap(([name, agent]) =>
    isRecord(agent) ? [[name, Object.fromEntries(Object.entries(agent).filter(([key]) =>
      ["description", "prompt", "model", "temperature", "top_p", "mode", "hidden", "disable", "steps", "tools", "permission"].includes(key)))]] : []));
  return config;
}

function quote(name: string) { return `"${name.replaceAll('"', '""')}"`; }

/** Translate path values and path-shaped permission keys, never prose. */
export function remapPaths(value: unknown, projects: SyncProject[], roots: Map<string, string>): unknown {
  const translate = (input: string) => {
    for (const project of [...projects].sort((a, b) => b.sourcePath.length - a.sourcePath.length)) {
      const target = roots.get(project.id);
      if (!target) continue;
      const source = project.sourcePath.replace(/[\\/]+$/, "");
      if (input === source || input.startsWith(`${source}/`) || input.startsWith(`${source}\\`)) {
        return target + input.slice(source.length).replaceAll("\\", "/");
      }
      const sourceUrl = pathToFileURL(source).href;
      if (input === sourceUrl || input.startsWith(`${sourceUrl}/`)) return pathToFileURL(target).href + input.slice(sourceUrl.length);
    }
    return input;
  };
  if (typeof value === "string") return translate(value);
  if (Array.isArray(value)) return value.map(item => remapPaths(item, projects, roots));
  if (!isRecord(value)) return value;
  const prose = new Set(["text", "prompt", "customInstructions", "output", "content", "title", "description", "label"]);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [translate(key), prose.has(key) ? child : remapPaths(child, projects, roots)]));
}

export function safeFolderPermissions(value: Record<string, unknown>, roots: string[]): Record<string, unknown> {
  const permission = value.permission;
  let mapped = value;
  if (isRecord(permission) && isRecord(permission.external_directory)) {
    const allowed = Object.fromEntries(Object.entries(permission.external_directory).filter(([path]) =>
      roots.some(root => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))));
    mapped = { ...mapped, permission: { ...permission, external_directory: { "*": "deny", ...allowed } } };
  }
  if (isRecord(value.agent)) mapped = { ...mapped, agent: Object.fromEntries(Object.entries(value.agent).map(([name, agent]) =>
    [name, isRecord(agent) ? safeFolderPermissions(agent, roots) : agent])) };
  return mapped;
}

/** VACUUM INTO reads a consistent SQLite snapshot, including committed WAL. */
async function copyDatabase(source: string, destination: string) {
  const reader = await openSqliteReadonly(source);
  try { reader.run("VACUUM INTO ?", [destination]); }
  finally { reader.close(); }
}

async function sanitizeDatabase(path: string, kind: "runtime" | "engine", projects: SyncProject[], roots?: Map<string, string>) {
  const db = await openSqlite(path);
  const allowed = kind === "runtime" ? RUNTIME_TABLES : ENGINE_TABLES;
  try {
    if (db.get("PRAGMA integrity_check")?.integrity_check !== "ok") throw new Error("Invalid checkpoint database");
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA secure_delete = ON");
    // A checkpoint has no executable views/triggers from another installation.
    for (const row of db.all("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'")) {
      if (row.type !== "table" || !allowed.has(String(row.name))) db.exec(`DROP ${String(row.type).toUpperCase()} IF EXISTS ${quote(String(row.name))}`);
    }
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map(row => String(row.name));
    if (kind === "runtime" && tables.includes("runtime_opencode_configs")) {
      for (const row of db.all("SELECT workspace_id, config_json FROM runtime_opencode_configs")) {
        const parsed = portableConfig(JSON.parse(String(row.config_json)));
        const mapped = roots ? remapPaths(parsed, projects, roots) : parsed;
        const safe = isRecord(mapped) ? safeFolderPermissions(mapped, roots ? [...roots.values()] : projects.map(project => project.sourcePath)) : {};
        db.run("UPDATE runtime_opencode_configs SET config_json = ? WHERE workspace_id = ?", [JSON.stringify(safe), String(row.workspace_id)]);
      }
    }
    if (kind === "engine" && tables.includes("session")) {
      const columns = db.all("PRAGMA table_info(session)");
      if (!columns.some(column => column.name === "directory")) throw new Error("Unsupported engine session schema");
      const ids = db.all("SELECT id, directory FROM session").filter(row => projects.some(project => {
        const directory = String(row.directory);
        return directory === project.sourcePath || directory.startsWith(`${project.sourcePath}${sep}`);
      })).map(row => String(row.id));
      // A private LegalWork checkpoint must not adopt unrelated standalone chats.
      db.exec("CREATE TEMP TABLE kept_sessions (id TEXT PRIMARY KEY)");
      for (const id of ids) db.run("INSERT INTO kept_sessions VALUES (?)", [id]);
      for (const table of ["part", "message", "todo"]) {
        if (tables.includes(table) && db.all(`PRAGMA table_info(${quote(table)})`).some(column => column.name === "session_id")) {
          db.run(`DELETE FROM ${quote(table)} WHERE session_id NOT IN (SELECT id FROM kept_sessions)`);
        }
      }
      db.run("DELETE FROM session WHERE id NOT IN (SELECT id FROM kept_sessions)");
      if (columns.some(column => column.name === "parent_id")) db.run("UPDATE session SET parent_id = NULL WHERE parent_id NOT IN (SELECT id FROM kept_sessions)");
      if (columns.some(column => column.name === "project_id")) {
        for (const table of ["project", "permission"]) {
          if (!tables.includes(table)) continue;
          const key = table === "project" ? "id" : "project_id";
          if (db.all(`PRAGMA table_info(${quote(table)})`).some(column => column.name === key))
            db.run(`DELETE FROM ${quote(table)} WHERE ${quote(key)} NOT IN (SELECT project_id FROM session)`);
        }
      }
      if (tables.includes("workspace") && columns.some(column => column.name === "workspace_id"))
        db.run("DELETE FROM workspace WHERE id NOT IN (SELECT workspace_id FROM session WHERE workspace_id IS NOT NULL)");
    }
    if (roots) {
      for (const table of tables) {
        const info = db.all(`PRAGMA table_info(${quote(table)})`);
        const columns = info.filter(column => /TEXT/i.test(String(column.type)));
        const keys = info.filter(column => Number(column.pk) > 0).map(column => String(column.name));
        const identity = keys.length ? keys : ["sync_rowid"];
        // No blind substitution through message text or user instructions.
        for (const row of db.all(`SELECT ${keys.length ? "*" : "rowid AS sync_rowid, *"} FROM ${quote(table)}`)) {
          for (const column of columns) {
            const name = String(column.name), value = row[name];
            if (typeof value !== "string") continue;
            let mapped: unknown = value;
            if (["directory", "worktree", "path"].includes(name)) mapped = remapPaths(value, projects, roots);
            else if (name === "data" || name.endsWith("_json")) {
              try { mapped = JSON.stringify(remapPaths(JSON.parse(value), projects, roots)); } catch { continue; }
            }
            if (typeof mapped === "string" && mapped !== value) {
              const values: SqlValue[] = identity.map(key => {
                const item = row[key];
                if (typeof item === "string" || typeof item === "number" || item === null) return item;
                throw new Error("Unsupported checkpoint primary key");
              });
              db.run(`UPDATE ${quote(table)} SET ${quote(name)} = ? WHERE ${identity.map(key => `${quote(key === "sync_rowid" ? "rowid" : key)} IS ?`).join(" AND ")}`, [mapped, ...values]);
            }
          }
        }
      }
    }
    db.exec("VACUUM");
  } finally { db.close?.(); }
}

/** Restore application tables in-place: target credential stores and already
 * opened host auth connections survive. No imported SQL outside allowed tables. */
async function mergeRuntime(source: string, destination: string) {
  const incoming = await openSqliteReadonly(source), target = await openSqlite(destination);
  try {
    const tables = incoming.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    for (const table of tables) {
      if (!RUNTIME_TABLES.has(String(table.name)) || typeof table.sql !== "string" || !/^CREATE TABLE\s/i.test(table.sql) || /;|--|\/\*/.test(table.sql)) {
        throw new Error("Unsupported checkpoint table definition");
      }
    }
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const row of target.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
        if (RUNTIME_TABLES.has(String(row.name)) && row.name !== "runtime_opencode_configs") target.exec(`DROP TABLE ${quote(String(row.name))}`);
      }
      for (const table of tables) {
        const name = String(table.name);
        if (name === "runtime_opencode_configs") {
          target.exec("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
          for (const row of incoming.all("SELECT * FROM runtime_opencode_configs")) {
            const local = target.get("SELECT config_json FROM runtime_opencode_configs WHERE workspace_id = ?", [String(row.workspace_id)]);
            const credentials: unknown = local ? JSON.parse(String(local.config_json)) : {};
            const base = isRecord(credentials) ? Object.fromEntries(Object.entries(credentials).filter(([key]) => !PORTABLE_CONFIG_FIELDS.has(key))) : {};
            const merged = { ...base, ...portableConfig(JSON.parse(String(row.config_json))) };
            target.run("INSERT INTO runtime_opencode_configs VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at",
              [String(row.workspace_id), JSON.stringify(merged), Number(row.updated_at)]);
          }
          continue;
        }
        target.exec(String(table.sql));
        const columns = incoming.all(`PRAGMA table_info(${quote(name)})`).map(column => String(column.name));
        for (const row of incoming.all(`SELECT * FROM ${quote(name)}`)) {
          const values: SqlValue[] = columns.map(column => {
            const value = row[column];
            if (value === null || typeof value === "string" || typeof value === "number") return value;
            throw new Error("Unsupported checkpoint column type");
          });
          target.run(`INSERT INTO ${quote(name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`, values);
        }
      }
      target.exec("COMMIT");
    } catch (error) { target.exec("ROLLBACK"); throw error; }
  } finally { incoming.close(); target.close?.(); }
}

/** A companion creates an independent executor, so pending local work must
 * not be replayed and existing schedules keep their desktop authority. */
async function prepareCompanionSeed(path: string) {
  const db = await openSqlite(path);
  try {
    db.exec("PRAGMA secure_delete = ON");
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => String(row.name)));
    for (const table of ["assistant_session_queue", "assistant_delegations", "assistant_delegation_receipts",
      "channel_runtime_owner", "channel_runtime_jobs", "channel_runtime_conversations", "channel_runtime_commands", "channel_runtime_approvals"]) {
      if (tables.has(table)) db.exec(`DELETE FROM ${quote(table)}`);
    }
    if (tables.has("scheduled_tasks")) db.exec("UPDATE scheduled_tasks SET data = json_set(data, '$.status', 'paused', '$.nextRunAt', NULL) WHERE json_extract(data, '$.status') = 'active'");
    if (tables.has("scheduled_task_runs")) db.exec("DELETE FROM scheduled_task_runs WHERE json_extract(data, '$.status') = 'dispatching'");
    db.exec("VACUUM");
  } finally { db.close?.(); }
}

export async function exportCheckpoint(config: ServerConfig, store: SyncObjects, options: { companionSeed?: boolean } = {}): Promise<Checkpoint> {
  const links = await projectSyncStore(config);
  const projects: SyncProject[] = await Promise.all(config.workspaces.filter(workspace => workspace.workspaceType !== "remote").map(async workspace => ({
    id: workspace.id, name: workspace.name, preset: workspace.preset, sourcePath: resolve(workspace.path), projectId: links.linkByWorkspace(workspace.id)?.projectId ?? null,
    details: existsSync(workspace.path) ? await readProjectDetails(workspace.path) : undefined,
  })));
  const temporary = await mkdtemp(join(tmpdir(), "legalwork-checkpoint-"));
  try {
    const save = async (source: string, kind: "runtime" | "engine") => {
      if (!existsSync(source)) return null;
      const destination = join(temporary, `${kind}.sqlite`);
      await copyDatabase(source, destination);
      await sanitizeDatabase(destination, kind, projects);
      if (kind === "runtime" && options.companionSeed) await prepareCompanionSeed(destination);
      return putBlob(store, destination);
    };
    return CheckpointSchema.parse({ version: 1, engineVersion: constants.opencodeVersion,
      timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, projects,
      approval: config.approval,
      runtime: await save(runtimeDbPath(config), "runtime"), engine: await save(localSessionDatabasePath(config), "engine") });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function projectRoots(config: ServerConfig, checkpoint: Checkpoint, directory: string) {
  return new Map(checkpoint.projects.map(project => [project.id,
    config.workspaces.find(workspace => workspace.id === project.id)?.path ?? join(resolve(directory), project.id)]));
}

const RestoreJournalSchema = z.object({ checkpoint: CheckpointSchema, roots: z.array(z.tuple([z.string(), z.string()])) }).strict();

/** Idempotent replay before the engine starts. Staged databases stay available
 * until both databases and the workspace catalog have been installed. */
export async function recoverCheckpointRestore(config: ServerConfig) {
  const runtime = runtimeDbPath(config), staging = join(dirname(runtime), "cloud-sync-restore");
  const journal = join(staging, "pending.json");
  if (!existsSync(journal)) return false;
  const pending = RestoreJournalSchema.parse(JSON.parse(await readFile(journal, "utf8")));
  const roots = new Map(pending.roots);
  if (pending.checkpoint.engineVersion !== constants.opencodeVersion) throw new Error("Complete the pending restore with the matching engine version");
  for (const [kind, reference, destination] of [["runtime", pending.checkpoint.runtime, runtime], ["engine", pending.checkpoint.engine, join(dirname(runtime), MANAGED_ENGINE_DB_FILENAME)]] satisfies Array<["runtime" | "engine", Checkpoint["runtime"], string]>) {
    if (!reference) continue;
    const source = join(staging, `${kind}.sqlite`);
    if (!existsSync(source)) throw new Error("A staged checkpoint database is missing; repeat the offline restore");
    if (existsSync(destination) && !existsSync(`${destination}.before-cloud-sync`)) await copyDatabase(destination, `${destination}.before-cloud-sync`);
    if (kind === "runtime") { await mergeRuntime(source, destination); continue; }
    for (const suffix of ["-wal", "-shm"]) await rm(`${destination}${suffix}`, { force: true });
    await copyFile(source, `${destination}.restore`);
    await rename(`${destination}.restore`, destination);
  }
  config.workspaces = pending.checkpoint.projects.map(project => {
    const path = roots.get(project.id);
    if (!path) throw new Error("The pending restore has no project root");
    return { id: project.id, name: project.name, preset: project.preset, path, workspaceType: "local" };
  });
  config.authorizedRoots = [...roots.values()];
  for (const project of pending.checkpoint.projects) {
    const root = roots.get(project.id);
    if (root && project.details) await restoreProjectDetails(root, remapPaths(project.details, pending.checkpoint.projects, roots));
  }
  if (pending.checkpoint.approval) config.approval = pending.checkpoint.approval;
  process.env.TZ = pending.checkpoint.timeZone;
  if (config.configPath) {
    const existing: unknown = existsSync(config.configPath) ? JSON.parse(await readFile(config.configPath, "utf8")) : {};
    const settings = isRecord(existing) ? existing : {};
    await writeFile(`${config.configPath}.restore`, JSON.stringify({ ...settings, workspaces: config.workspaces, authorizedRoots: config.authorizedRoots, approval: config.approval }, null, 2), { mode: 0o600 });
    await rename(`${config.configPath}.restore`, config.configPath);
  }
  await rm(journal);
  return true;
}

/** Offline-only. Stage both databases before changing either live target. */
export async function restoreCheckpoint(config: ServerConfig, store: SyncObjects, input: Checkpoint, directory: string, replace: boolean) {
  if (existsSync(join(dirname(runtimeDbPath(config)), "cloud-sync-restore", "pending.json"))) await recoverCheckpointRestore(config);
  const checkpoint = CheckpointSchema.parse(input);
  if (checkpoint.engineVersion !== constants.opencodeVersion) throw new ApiError(409, "sync_engine_version", `Checkpoint requires OpenCode ${checkpoint.engineVersion}; this image has ${constants.opencodeVersion}.`);
  const runtime = runtimeDbPath(config), engine = join(dirname(runtime), MANAGED_ENGINE_DB_FILENAME);
  const hasData = async (path: string, tables: Set<string>) => {
    if (!existsSync(path)) return false;
    const db = await openSqliteReadonly(path);
    try {
      for (const table of db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
        if (table.name === "runtime_opencode_configs") {
          if (db.all("SELECT config_json FROM runtime_opencode_configs").some(row => Object.keys(portableConfig(JSON.parse(String(row.config_json)))).length > 0)) return true;
          continue;
        }
        if (tables.has(String(table.name)) && db.all(`SELECT 1 FROM ${quote(String(table.name))} LIMIT 1`).length) return true;
      }
      return false;
    } finally { db.close(); }
  };
  if (!replace && (await hasData(runtime, RUNTIME_TABLES) || await hasData(engine, new Set(["session"])))) {
    throw new ApiError(409, "sync_existing_state", "Existing state needs an explicit offline restore with --replace.");
  }
  const roots = projectRoots(config, checkpoint, directory);
  const sync = await projectSyncStore(config);
  for (const root of roots.values()) {
    if (!existsSync(root)) sync.forgetFileRoots(root);
    await mkdir(root, { recursive: true });
  }
  const staging = join(dirname(runtime), "cloud-sync-restore");
  await mkdir(staging, { recursive: true });
  for (const [kind, reference, destination] of [["runtime", checkpoint.runtime, runtime], ["engine", checkpoint.engine, engine]] satisfies Array<["runtime" | "engine", Checkpoint["runtime"], string]>) {
    if (!reference) continue;
    const source = join(staging, `${kind}.sqlite`);
    await rm(source, { force: true });
    await getBlob(store, reference, source);
    await sanitizeDatabase(source, kind, checkpoint.projects, roots);
  }
  // Publish the journal only after every download and validation succeeded.
  const journal = join(staging, "pending.json");
  await writeFile(journal, JSON.stringify({ checkpoint, roots: [...roots] }), { mode: 0o600 });
  await recoverCheckpointRestore(config);
  return roots;
}

export async function nextScheduledRun(config: ServerConfig) {
  const path = runtimeDbPath(config);
  if (!existsSync(path)) return null;
  const db = await openSqliteReadonly(path);
  try {
    if (!db.all("SELECT name FROM sqlite_master WHERE name = 'scheduled_tasks'").length) return null;
    const row: Row | undefined = db.all("SELECT min(json_extract(data, '$.nextRunAt')) AS due FROM scheduled_tasks WHERE json_extract(data, '$.status') = 'active'")[0];
    return typeof row?.due === "string" ? row.due : null;
  } finally { db.close(); }
}
