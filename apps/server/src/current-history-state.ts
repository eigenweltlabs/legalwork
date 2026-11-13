import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionV1 } from "@opencode/schema/session-v1";
import * as Permission from "@opencode/schema/permission";
import { Schema } from "effect";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { engineStorageDir } from "./engine-storage.js";
import { legacyHistoryBackupDirectory, readLegacyHistoryBackup } from "./history-v1-backup.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import { beginNativeConfigComponent, completeNativeConfigComponent } from "./runtime-opencode-config-store.js";
import { ScheduledTaskMessageSchema } from "./native-shared-values.js";
import type { ServerConfig } from "./types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const historyBytesHash = (value: string) => createHash("sha256").update(Buffer.from(value, "base64")).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const policySchema = z.object({ rules: z.custom<typeof Permission.Ruleset.Type>(Schema.is(Permission.Ruleset)), directory: z.string(), createdAt: z.number(), parentID: z.string().nullable(), worktree: z.string().optional() }).strict();
export type HistorySourcePolicy = z.infer<typeof policySchema>;
const undoSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("none") }), z.object({ status: z.literal("unresolved"), reason: z.string() }), z.object({ status: z.literal("restorable"), messageID: z.string(), snapshot: z.string().optional() })]);
const sessionSchema = z.object({
  directory: z.string().nullable(),
  policy: z.discriminatedUnion("status", [z.object({ status: z.literal("none") }), z.object({ status: z.literal("unresolved"), reason: z.string() }), z.object({ status: z.literal("available"), source: policySchema })]),
  undo: undoSchema,
  messages: z.record(z.string(), z.object({ createdAt: z.number(), scheduled: z.array(z.object({ text: z.string(), task: ScheduledTaskMessageSchema })), attachments: z.array(z.object({ partID: z.string(), name: z.string().optional(), mime: z.string(), reference: z.string().optional(), sourcePath: z.string().optional(), inlineHash: z.string().optional() })) })),
}).strict();
const undoReceiptSchema = z.object({ version: z.literal(1), sourceSha256: z.string(), sessionID: z.string(), restoredAt: z.number() }).strict();
const permissionReceiptSchema = undoReceiptSchema.extend({ sourceRuleHash: z.string(), contextHash: z.string() });
const stateSchema = z.object({ version: z.literal(1), sourceSha256: z.string(), sessions: z.record(z.string(), sessionSchema), undoReceipts: z.record(z.string(), undoReceiptSchema), permissionReceipts: z.record(z.string(), permissionReceiptSchema) }).strict();
export type CurrentHistoryState = z.infer<typeof stateSchema>;
const markerSchema = z.object({ version: z.literal(1), sourceSha256: z.string(), recordsHash: z.string() }).strict();
const envelopeSchema = z.object({ sha256: z.string(), state: stateSchema }).strict();
const paths = (config: ServerConfig) => ({ state: join(engineStorageDir(config), "history-current.json"), marker: join(engineStorageDir(config), "history-import-state.json") });
const locks = new Map<string, Promise<unknown>>();
function locked<T>(config: ServerConfig, operation: () => Promise<T>): Promise<T> {
  const key = paths(config).state, task = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  locks.set(key, task);
  return task.finally(() => { if (locks.get(key) === task) locks.delete(key); });
}
function hold(): never { throw new ApiError(409, "history_state_recovery_required", "Saved chat migration data is missing or damaged. Restore its private recovery copy before running older chats."); }
async function readJson(path: string): Promise<unknown | undefined> {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) return hold(); return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (missing(error)) return; return hold(); }
}
async function publish(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    try { const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    catch (error) { if (!(process.platform === "win32" && error instanceof Error && "code" in error && ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(String(error.code)))) throw error; }
  }
  finally { await rm(temporary, { force: true }); }
}
function parseObject(value: unknown): Record<string, unknown> | undefined {
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(String(value))); } catch { return; }
}
const legacyRules = z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"]) }).strict());
/** Only the one-time importer understands V1 permission names. */
export function importLegacySessionPermissionRules(value: unknown): typeof Permission.Ruleset.Type {
  if (value === null) return [];
  return Schema.decodeUnknownSync(Permission.Ruleset)(legacyRules.parse(value).map(rule => ({ action: rule.permission === "bash" ? "shell" : rule.permission === "task" ? "subagent" : rule.permission, resource: rule.pattern, effect: rule.action })));
}

async function importState(config: ServerConfig): Promise<CurrentHistoryState | null> {
  const backup = await readLegacyHistoryBackup(config);
  if (!backup) {
    // Earlier migrations already recorded an expected original. Its loss is
    // different from a fresh installation with no history to import.
    if (await readJson(join(engineStorageDir(config), "opencode-v2-history-migration.json"))) return hold();
    return null;
  }
  const state: CurrentHistoryState = { version: 1, sourceSha256: backup.sha256, sessions: {}, undoReceipts: {}, permissionReceipts: {} };
  const db = await openSqliteReadonly(backup.path);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
    if (!tables.has("session")) return state;
    for (const row of db.all("SELECT * FROM session")) {
      if (typeof row.id !== "string") return hold();
      const directory = typeof row.directory === "string" ? await canonicalFilePath(row.directory) : null;
      const record: CurrentHistoryState["sessions"][string] = { directory, policy: { status: "none" }, undo: { status: "none" }, messages: {} };
      state.sessions[row.id] = record;
      if (row.permission !== null && row.permission !== undefined) {
        try {
          const rules = importLegacySessionPermissionRules(JSON.parse(String(row.permission)));
          if (rules.length) {
            if (!directory || typeof row.time_created !== "number" || row.parent_id !== null && row.parent_id !== undefined && typeof row.parent_id !== "string") throw new Error("original_context_unavailable");
            const project = tables.has("project") && typeof row.project_id === "string" ? db.all("SELECT worktree FROM project WHERE id=?", [row.project_id])[0] : undefined;
            record.policy = { status: "available", source: { rules, directory, createdAt: row.time_created, parentID: typeof row.parent_id === "string" ? row.parent_id : null, ...(typeof project?.worktree === "string" ? { worktree: await canonicalFilePath(project.worktree) } : {}) } };
          }
        } catch (error) { record.policy = { status: "unresolved", reason: error instanceof Error && error.message === "original_context_unavailable" ? error.message : "original_permissions_invalid" }; }
      }
      if (row.revert !== null && row.revert !== undefined) {
        const value = parseObject(row.revert), revert = z.object({ messageID: z.string(), partID: z.string().optional(), snapshot: z.string().optional(), diff: z.string().optional(), files: z.array(z.unknown()).optional() }).safeParse(value);
        let reason: string | undefined;
        if (!revert.success) reason = "original_revert_invalid";
        else if (revert.data.partID) reason = "partial_part_revert_unsupported";
        else if (revert.data.diff?.trim() || revert.data.files?.length) reason = "file_redo_state_unsupported";
        else if (!tables.has("part")) reason = "original_patch_evidence_unavailable";
        else for (const part of db.all("SELECT data FROM part WHERE session_id=? AND message_id>=?", [row.id, revert.data.messageID])) {
          const data = parseObject(part.data);
          if (!data) { reason = "original_patch_evidence_invalid"; break; }
          if (data.type === "patch" && Array.isArray(data.files) && data.files.length) { reason = "file_patch_revert_unsupported"; break; }
        }
        record.undo = reason ? { status: "unresolved", reason } : revert.success ? { status: "restorable", messageID: revert.data.messageID, ...(revert.data.snapshot ? { snapshot: revert.data.snapshot } : {}) } : { status: "unresolved", reason: "original_revert_invalid" };
      }
      if (tables.has("message") && tables.has("part")) {
        for (const message of db.all("SELECT id,time_created,data FROM message WHERE session_id=?", [row.id])) {
          const value = parseObject(message.data);
          if (typeof message.id !== "string" || typeof message.time_created !== "number" || !value || value.role !== "user" || !Schema.is(SessionV1.Info)({ ...value, id: message.id, sessionID: row.id })) continue;
          const details: CurrentHistoryState["sessions"][string]["messages"][string] = { createdAt: message.time_created, scheduled: [], attachments: [] };
          for (const part of db.all("SELECT id,data FROM part WHERE session_id=? AND message_id=? ORDER BY id", [row.id, message.id])) {
            const data = parseObject(part.data), input = data && { ...data, id: part.id, sessionID: row.id, messageID: message.id };
            if (!input || !Schema.is(SessionV1.Part)(input)) continue;
            if (input.type === "text" && !input.synthetic && !input.ignored) {
              const task = ScheduledTaskMessageSchema.safeParse(input.metadata?.legalworkScheduledTask);
              if (task.success) details.scheduled.push({ text: input.text, task: task.data });
            }
            if (input.type === "file") {
              let inlineHash: string | undefined;
              if (input.url.startsWith("data:")) {
                const comma = input.url.indexOf(","); if (comma < 0) continue;
                try { inlineHash = historyBytesHash(input.url.slice(0, comma).endsWith(";base64") ? input.url.slice(comma + 1) : Buffer.from(decodeURIComponent(input.url.slice(comma + 1))).toString("base64")); } catch { continue; }
              }
              details.attachments.push({ partID: input.id, name: input.filename, mime: input.mime,
                ...(inlineHash ? { inlineHash } : { reference: input.url }),
                ...(input.source?.type === "file" || input.source?.type === "symbol" ? { sourcePath: input.source.path } : input.source?.type === "resource" ? { reference: input.source.uri } : {}) });
            }
          }
          if (details.scheduled.length || details.attachments.length) record.messages[message.id] = details;
        }
      }
      for (const kind of ["undo", "permission"] as const) {
        const filename = kind === "undo" ? createHash("sha256").update(row.id).digest("hex") : digest(row.id);
        const receipt = await readJson(join(legacyHistoryBackupDirectory(config), `${kind}-receipts`, filename + ".json"));
        if (receipt !== undefined) {
          if (kind === "undo") state.undoReceipts[row.id] = undoReceiptSchema.parse(receipt);
          else state.permissionReceipts[row.id] = permissionReceiptSchema.parse(receipt);
        }
      }
    }
  } finally { db.close(); }
  return state;
}

async function readState(config: ServerConfig): Promise<CurrentHistoryState | null> {
  const component = `chat-history.${createHash("sha256").update(engineStorageDir(config)).digest("hex")}`;
  const phase = await beginNativeConfigComponent(config, component);
  const path = paths(config), marker = await readJson(path.marker), stored = await readJson(path.state);
  if (phase === "complete" && (marker === undefined || stored === undefined)) return hold();
  if (stored !== undefined) {
    const parsed = envelopeSchema.safeParse(stored);
    if (!parsed.success || parsed.data.sha256 !== digest(parsed.data.state)) return hold();
    const expected = { version: 1, sourceSha256: parsed.data.state.sourceSha256, recordsHash: digest(parsed.data.state.sessions) };
    if (marker !== undefined && (!markerSchema.safeParse(marker).success || digest(marker) !== digest(expected))) return hold();
    if (marker === undefined) await publish(path.marker, expected); // Recover interrupted initial publication.
    if (phase !== "complete") await completeNativeConfigComponent(config, component);
    return parsed.data.state;
  }
  if (marker !== undefined) return hold();
  const state = await importState(config);
  if (!state) return null;
  await mkdir(engineStorageDir(config), { recursive: true, mode: 0o700 });
  await publish(path.state, { sha256: digest(state), state });
  await publish(path.marker, { version: 1, sourceSha256: state.sourceSha256, recordsHash: digest(state.sessions) });
  await completeNativeConfigComponent(config, component);
  return state;
}

/** Normal consumers use native typed state, never the retired V1 archive. */
export function readCurrentHistory(config: ServerConfig) { return locked(config, () => readState(config)); }
export function updateCurrentHistoryReceipt(config: ServerConfig, kind: "undo", sessionID: string, receipt: z.infer<typeof undoReceiptSchema>): Promise<void>;
export function updateCurrentHistoryReceipt(config: ServerConfig, kind: "permission", sessionID: string, receipt: z.infer<typeof permissionReceiptSchema>): Promise<void>;
export function updateCurrentHistoryReceipt(config: ServerConfig, kind: "undo" | "permission", sessionID: string, receipt: z.infer<typeof permissionReceiptSchema> | z.infer<typeof undoReceiptSchema>): Promise<void> {
  return locked(config, async () => {
    const state = await readState(config);
    if (!state || !state.sessions[sessionID] || receipt.sourceSha256 !== state.sourceSha256 || receipt.sessionID !== sessionID) return hold();
    if (kind === "undo") state.undoReceipts[sessionID] = undoReceiptSchema.parse(receipt);
    else state.permissionReceipts[sessionID] = permissionReceiptSchema.parse(receipt);
    await publish(paths(config).state, { sha256: digest(state), state });
  });
}
