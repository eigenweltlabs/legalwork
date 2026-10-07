import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApiError } from "./errors.js";
import { createDefaultProjectFolder, defaultProjectRoot } from "./project-store.js";
import { registerLocalProject } from "./routes/workspaces.js";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { AssistantProfileSchema, DEFAULT_ASSISTANT_PROFILE } from "./assistant-schema.js";
import type { AssistantProfile } from "@legalwork/types/main-assistant";

export const MAIN_ASSISTANT_PRESET = "main-assistant";
export const isMainAssistant = (workspace: { preset?: string }) => workspace.preset === MAIN_ASSISTANT_PRESET;

/** Calendar days follow the device, including DST and changes to its time zone. */
export function assistantDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

type Session = { id: string; title: string; directory: string; parentID?: string; time: { archived?: number } };
export type AssistantDay = { date: string; sessionId: string };
type AssistantEngine = {
  list: () => Promise<Session[]>;
  get: (id: string) => Promise<Session | null>;
  create: (title: string) => Promise<Session>;
};

/** One server-owned project, with one independent engine context per local day. */
export class MainAssistant {
  private pending: Promise<{ workspace: WorkspaceInfo; day: AssistantDay }> | null = null;
  private workspacePending: Promise<WorkspaceInfo> | null = null;
  private constructor(
    private config: ServerConfig,
    private db: SqliteHandle,
    private engine: (workspace: WorkspaceInfo) => AssistantEngine,
    private changed: () => void,
    private now: () => Date,
  ) {}

  static async open(config: ServerConfig, dbPath: string, engine: (workspace: WorkspaceInfo) => AssistantEngine, changed = () => {}, now = () => new Date()) {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = await openSqlite(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS assistant_days (workspace_id TEXT NOT NULL, date TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(workspace_id, date))");
    db.exec("CREATE TABLE IF NOT EXISTS assistant_profiles (workspace_id TEXT PRIMARY KEY, name TEXT, icon TEXT NOT NULL)");
    return new MainAssistant(config, db, engine, changed, now);
  }

  workspace() {
    if (!this.workspacePending) this.workspacePending = this.ensureWorkspace().finally(() => { this.workspacePending = null; });
    return this.workspacePending;
  }

  profile(): AssistantProfile {
    const workspace = this.config.workspaces.find(isMainAssistant);
    const row = workspace ? this.db.get("SELECT name, icon FROM assistant_profiles WHERE workspace_id = ?", [workspace.id]) : null;
    return row ? AssistantProfileSchema.parse(row) : DEFAULT_ASSISTANT_PROFILE;
  }

  async updateProfile(profile: AssistantProfile) {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "The main assistant requires a writable server.");
    const workspace = await this.workspace();
    const parsed = AssistantProfileSchema.parse(profile);
    this.db.run("INSERT INTO assistant_profiles (workspace_id, name, icon) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET name = excluded.name, icon = excluded.icon", [workspace.id, parsed.name, parsed.icon]);
    this.changed();
    return parsed;
  }

  private async ensureWorkspace() {
    const existing = this.config.workspaces.find(isMainAssistant);
    if (existing) {
      const folder = await stat(existing.path).catch(() => null);
      if (!folder?.isDirectory()) throw new ApiError(404, "assistant_folder_unavailable", "The assistant project folder is unavailable. Restore its folder to continue.");
      return existing;
    }
    if (this.config.readOnly) throw new ApiError(403, "read_only", "The main assistant requires a writable server.");
    const folderPath = await createDefaultProjectFolder("Assistant", defaultProjectRoot(this.config.projectsDirectory));
    const { workspace } = await registerLocalProject(this.config, { folderPath, name: "Assistant", preset: MAIN_ASSISTANT_PRESET, position: "last" });
    this.changed();
    return workspace;
  }

  current() {
    if (!this.pending) this.pending = this.ensureDay().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async ensureDay() {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "The main assistant requires a writable server.");
    const workspace = await this.workspace();
    const date = assistantDate(this.now());
    const engine = this.engine(workspace);
    const row = this.db.get("SELECT session_id FROM assistant_days WHERE workspace_id = ? AND date = ?", [workspace.id, date]);
    let session = row ? await engine.get(String(row.session_id)) : null;
    if (session && (resolve(session.directory) !== resolve(workspace.path) || session.time.archived)) session = null;
    // Recover an engine creation that succeeded just before a server crash.
    if (!session) session = (await engine.list()).find(item => item.title === date && !item.parentID && !item.time.archived && resolve(item.directory) === resolve(workspace.path)) ?? null;
    if (!session) session = await engine.create(date);
    if (resolve(session.directory) !== resolve(workspace.path)) throw new ApiError(502, "assistant_session_scope", "The engine returned a chat outside the assistant project.");
    if (row?.session_id !== session.id) {
      this.db.run("INSERT INTO assistant_days (workspace_id, date, session_id) VALUES (?, ?, ?) ON CONFLICT(workspace_id, date) DO UPDATE SET session_id = excluded.session_id", [workspace.id, date, session.id]);
      this.changed();
    }
    return { workspace, day: { date, sessionId: session.id } };
  }

  history(workspaceId: string, before?: string, limit = 14) {
    const rows = this.db.all("SELECT date, session_id FROM assistant_days WHERE workspace_id = ? AND date < ? ORDER BY date DESC LIMIT ?", [workspaceId, before ?? "9999-99-99", limit + 1]);
    const days = rows.slice(0, limit).map(row => ({ date: String(row.date), sessionId: String(row.session_id) }));
    return { days, nextBefore: rows.length > limit ? days[days.length - 1].date : null };
  }

  start() {
    let stopped = false;
    // Check at midnight, and at least every minute to catch wake and clock changes.
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try { if (this.config.workspaces.some(isMainAssistant)) await this.current(); } catch (error) { console.warn("[main-assistant]", error instanceof Error ? error.message : String(error)); }
      if (stopped) return;
      const now = this.now();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => void tick(), Math.max(100, Math.min(60_000, midnight.getTime() - now.getTime())));
      timer.unref();
    };
    void tick();
    return async () => { stopped = true; clearTimeout(timer); await this.pending?.catch(() => {}); };
  }
}
