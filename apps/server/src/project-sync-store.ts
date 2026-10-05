import { projectRemoteSchema } from "./project-schema.js";
import { dirname } from "node:path";
import type { ProjectSyncConflict, ProjectSyncSettings, ProjectSyncSkipped } from "@legalwork/types/workspace";
import { z } from "zod";

import type { FileBase, FileBaseStore } from "./project-file-sync.js";
import type { ReviewBase, ReviewBaseStore } from "./project-review-sync.js";
import type { RemoteFileIndex } from "./eigenwelt-project-storage.js";
import type { RemoteProjectFile } from "./eigenwelt-projects.js";
import { openSqlite, runtimeDbPath, type Row, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from "./runtime-opencode-config-store.js";

/**
 * What this machine knows about its synced projects, in runtime.sqlite beside
 * the tasks: which local project is which of the firm's projects, the writes
 * still to push, and what each project's documents looked like when both
 * sides last agreed. project-sync.ts drives it; task-store.ts reads
 * `project_links` to tell a task of a local project from one that syncs.
 */

export const PROJECT_SYNC_SCHEMA = [
  // A local project (workspace) that syncs, and how. `origin` says where it
  // began: `local` on this machine (its folder is the user's own), `remote`
  // pulled from the firm (its folder was made by sync).
  `CREATE TABLE IF NOT EXISTS project_links (
    workspace_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    role TEXT NOT NULL,
    owner_user_id TEXT,
    settings_json TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    remote_updated_at TEXT,
    files_reconciled_at TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    allow_deletions INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER,
    last_error TEXT,
    report_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    op_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS project_file_base (
    project_id TEXT NOT NULL,
    path_key TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    PRIMARY KEY (project_id, path_key)
  )`,
  // The agreed content of text that is merged rather than copied when both
  // sides changed it (notes): the base of that merge.
  `CREATE TABLE IF NOT EXISTS project_file_base_text (
    project_id TEXT NOT NULL,
    path_key TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (project_id, path_key)
  )`,
  // The same for the project's Tabular Reviews and their earlier runs, by
  // their path at the firm; a review keeps its agreed text, to merge against.
  `CREATE TABLE IF NOT EXISTS project_review_base (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    content TEXT,
    PRIMARY KEY (project_id, path)
  )`,
  // The firm's listing of each project's documents as last seen, and the
  // number of its last change: the next listing asks only what changed since.
  `CREATE TABLE IF NOT EXISTS project_remote_files (
    project_id TEXT NOT NULL,
    path_key TEXT NOT NULL,
    file_json TEXT NOT NULL,
    PRIMARY KEY (project_id, path_key)
  )`,
  `CREATE TABLE IF NOT EXISTS project_remote_seq (
    project_id TEXT PRIMARY KEY NOT NULL,
    seq INTEGER NOT NULL
  )`,
  // Copies kept when both sides changed a file, until the user dismisses them.
  `CREATE TABLE IF NOT EXISTS project_conflicts (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    copy_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, copy_path)
  )`,
  `CREATE TABLE IF NOT EXISTS project_sync_state (
    org_id TEXT PRIMARY KEY NOT NULL,
    pull_cursor TEXT,
    last_pull_at INTEGER,
    last_error TEXT
  )`,
  // Firm projects the user removed from this computer: not brought back by a pull.
  `CREATE TABLE IF NOT EXISTS project_removed (
    project_id TEXT PRIMARY KEY NOT NULL,
    org_id TEXT NOT NULL,
    removed_at INTEGER NOT NULL
  )`,
  // Projects their owner stopped syncing here: shared again, each is the same
  // project at the firm, so a colleague's held-back copy takes it up again.
  `CREATE TABLE IF NOT EXISTS project_stopped (
    workspace_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    org_id TEXT NOT NULL
  )`,
  // A firm project shared with this member whose id one of their own
  // projects' folders already carries (a folder on a shared drive, say). Never
  // taken over silently: the member decides to use that folder as their copy
  // ("use") or to keep the two apart ("separate"); until then nothing arrives.
  `CREATE TABLE IF NOT EXISTS project_offers (
    project_id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    decision TEXT,
    created_at INTEGER NOT NULL
  )`,
  // Recordings already copied into a project's folder: each is copied once,
  // and a copy the member deletes there stays deleted.
  `CREATE TABLE IF NOT EXISTS project_recording_exports (
    project_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    exported_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, recording_id)
  )`,
];

function jsonOf(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const remoteFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
  contentType: z.string(),
  updatedByUserId: z.string(),
  updatedAt: z.string(),
});

const scopeSchema = z.object({
  documents: z.boolean(),
  notes: z.boolean(),
  tasks: z.boolean(),
  recordings: z.boolean(),
  metadata: z.boolean(),
  // Shared before reviews were part of it: they stay out until the owner adds them.
  reviews: z.boolean().default(false),
  calendar: z.boolean().default(true),
});

export const projectSyncSettingsSchema = z.object({
  access: z.enum(["org", "members"]),
  memberIds: z.array(z.string().min(1).max(255)).max(500),
  scope: scopeSchema,
});

const fieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  labelSource: z.enum(["suggested", "custom"]).optional(),
  type: z.enum(["text", "number", "date", "select"]),
  value: z.union([z.string(), z.number(), z.null()]),
  options: z.array(z.string()).optional(),
});

const fieldChangeSchema = z.object({ id: z.string(), field: fieldSchema.nullable() });
export type FieldChange = z.infer<typeof fieldChangeSchema>;

const opSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }),
  z.object({ kind: z.literal("remote"), remote: projectRemoteSchema, changedAt: z.string() }),
  z.object({ kind: z.literal("rename"), name: z.string(), changedAt: z.string() }),
  z.object({ kind: z.literal("personalization"), prompt: z.string().max(MAX_CUSTOM_INSTRUCTIONS_LENGTH), changedAt: z.string() }),
  z.object({
    kind: z.literal("fields"),
    changes: z.array(fieldChangeSchema),
    order: z.array(z.string()).nullable(),
    changedAt: z.string(),
  }),
  z.object({ kind: z.literal("settings"), settings: projectSyncSettingsSchema }),
  z.object({ kind: z.literal("stop") }),
]);

/** A local write to a project record, waiting to be pushed. */
export type ProjectSyncOp = z.infer<typeof opSchema>;

const reportSchema = z.object({
  pending: z.number(),
  skipped: z.array(z.object({ path: z.string(), reason: z.enum(["too_large", "name_clash", "failed"]) })),
  heldDeletions: z.number(),
});

export type ProjectOutboxEntry = { seq: number; projectId: string; op: ProjectSyncOp; attempts: number };

/** What the last document round left open. */
export type ProjectFileReport = { pending: number; skipped: ProjectSyncSkipped[]; heldDeletions: number };

export type ProjectLink = {
  workspaceId: string;
  projectId: string;
  orgId: string;
  origin: "local" | "remote";
  role: "owner" | "member";
  ownerUserId: string | null;
  settings: ProjectSyncSettings;
  /** The firm has the project: its create went through, or it came from there. */
  confirmed: boolean;
  remoteUpdatedAt: string | null;
  /** `remoteUpdatedAt` as of the last full document reconcile. */
  filesReconciledAt: string | null;
  /** `revoked`: access ended while local changes were not uploaded; the user decides. */
  state: "active" | "revoked";
  /** The user confirmed deletions held back by the safety threshold, for the next round. */
  allowDeletions: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  report: ProjectFileReport | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const NO_SCOPE = { calendar: false, documents: false, notes: false, tasks: false, recordings: false, metadata: false, reviews: false };

export type ProjectOffer = {
  projectId: string;
  workspaceId: string;
  orgId: string;
  name: string;
  ownerUserId: string;
  decision: "use" | "separate" | null;
};

function toOffer(row: Row): ProjectOffer {
  const decision = nullableText(row.decision);
  return {
    projectId: text(row.project_id),
    workspaceId: text(row.workspace_id),
    orgId: text(row.org_id),
    name: text(row.name),
    ownerUserId: text(row.owner_user_id),
    decision: decision === "use" || decision === "separate" ? decision : null,
  };
}

function toLink(row: Row): ProjectLink {
  return {
    workspaceId: text(row.workspace_id),
    projectId: text(row.project_id),
    orgId: text(row.org_id),
    origin: row.origin === "remote" ? "remote" : "local",
    role: row.role === "member" ? "member" : "owner",
    ownerUserId: nullableText(row.owner_user_id),
    settings: parseJson(projectSyncSettingsSchema, row.settings_json) ?? { access: "members", memberIds: [], scope: NO_SCOPE },
    confirmed: row.confirmed === 1,
    remoteUpdatedAt: nullableText(row.remote_updated_at),
    filesReconciledAt: nullableText(row.files_reconciled_at),
    state: row.state === "revoked" ? "revoked" : "active",
    allowDeletions: row.allow_deletions === 1,
    lastSyncAt: nullableNumber(row.last_sync_at),
    lastError: nullableText(row.last_error),
    report: parseJson(reportSchema, row.report_json),
  };
}

export class ProjectSyncStore {
  private constructor(private readonly db: SqliteHandle) {}

  static async open(path: string): Promise<ProjectSyncStore> {
    await ensureDir(dirname(path));
    const db = await openSqlite(path);
    db.exec("PRAGMA busy_timeout = 5000");
    for (const statement of PROJECT_SYNC_SCHEMA) db.exec(statement);
    return new ProjectSyncStore(db);
  }

  // --- Links -------------------------------------------------------------------

  links(orgId?: string): ProjectLink[] {
    const rows = orgId
      ? this.db.all("SELECT * FROM project_links WHERE org_id = ? ORDER BY created_at", [orgId])
      : this.db.all("SELECT * FROM project_links ORDER BY created_at");
    return rows.map(toLink);
  }

  linkByWorkspace(workspaceId: string): ProjectLink | null {
    const row = this.db.get("SELECT * FROM project_links WHERE workspace_id = ?", [workspaceId]);
    return row ? toLink(row) : null;
  }

  linkByProject(projectId: string): ProjectLink | null {
    const row = this.db.get("SELECT * FROM project_links WHERE project_id = ?", [projectId]);
    return row ? toLink(row) : null;
  }

  saveLink(link: ProjectLink, now: number = Date.now()): void {
    this.db.run(
      `INSERT INTO project_links (workspace_id, project_id, org_id, origin, role, owner_user_id, settings_json, confirmed,
         remote_updated_at, files_reconciled_at, state, allow_deletions, last_sync_at, last_error, report_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET project_id = excluded.project_id, org_id = excluded.org_id,
         origin = excluded.origin, role = excluded.role, owner_user_id = excluded.owner_user_id,
         settings_json = excluded.settings_json, confirmed = excluded.confirmed, remote_updated_at = excluded.remote_updated_at,
         files_reconciled_at = excluded.files_reconciled_at, state = excluded.state, allow_deletions = excluded.allow_deletions,
         last_sync_at = excluded.last_sync_at, last_error = excluded.last_error, report_json = excluded.report_json,
         updated_at = excluded.updated_at`,
      [
        link.workspaceId,
        link.projectId,
        link.orgId,
        link.origin,
        link.role,
        link.ownerUserId,
        JSON.stringify(link.settings),
        link.confirmed ? 1 : 0,
        link.remoteUpdatedAt,
        link.filesReconciledAt,
        link.state,
        link.allowDeletions ? 1 : 0,
        link.lastSyncAt,
        link.lastError ? link.lastError.slice(0, 500) : null,
        link.report === null ? null : JSON.stringify(link.report),
        now,
        now,
      ],
    );
  }

  /**
   * Change some of a link's fields against the row as it is now — a round
   * must not put back settings the member changed while it ran.
   */
  updateLink(workspaceId: string, patch: Partial<Omit<ProjectLink, "workspaceId" | "projectId">>): void {
    const current = this.linkByWorkspace(workspaceId);
    if (current) this.saveLink({ ...current, ...patch });
  }

  /** The project no longer syncs here: its link, compared state and kept conflicts go. */
  removeLink(workspaceId: string): void {
    const link = this.linkByWorkspace(workspaceId);
    if (!link) return;
    this.db.run("DELETE FROM project_file_base WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_file_base_text WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_review_base WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_remote_files WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_remote_seq WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_conflicts WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_recording_exports WHERE project_id = ?", [link.projectId]);
    this.db.run("DELETE FROM project_links WHERE workspace_id = ?", [workspaceId]);
  }

  // --- Outbox ------------------------------------------------------------------

  enqueue(projectId: string, op: ProjectSyncOp, now: number = Date.now()): void {
    this.db.run("INSERT INTO project_outbox (project_id, op_json, created_at) VALUES (?, ?, ?)", [
      projectId,
      JSON.stringify(op),
      now,
    ]);
  }

  outbox(): ProjectOutboxEntry[] {
    return this.db.all("SELECT * FROM project_outbox ORDER BY seq ASC LIMIT 500").flatMap((row) => {
      const op = parseJson(opSchema, row.op_json);
      return op === null
        ? []
        : [{ seq: nullableNumber(row.seq) ?? 0, projectId: text(row.project_id), op, attempts: nullableNumber(row.attempts) ?? 0 }];
    });
  }

  pendingOps(projectId: string): ProjectSyncOp[] {
    return this.db
      .all("SELECT op_json FROM project_outbox WHERE project_id = ? ORDER BY seq ASC", [projectId])
      .flatMap((row) => {
        const op = parseJson(opSchema, row.op_json);
        return op === null ? [] : [op];
      });
  }

  completeOutbox(seq: number): void {
    this.db.run("DELETE FROM project_outbox WHERE seq = ?", [seq]);
  }

  failOutbox(seq: number, error: string): void {
    this.db.run("UPDATE project_outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?", [error.slice(0, 500), seq]);
  }

  discardOutbox(projectId: string): void {
    this.db.run("DELETE FROM project_outbox WHERE project_id = ?", [projectId]);
  }

  // --- Documents -----------------------------------------------------------------

  fileBase(projectId: string): FileBaseStore {
    return {
      entries: () =>
        new Map(
          this.db
            .all("SELECT * FROM project_file_base WHERE project_id = ?", [projectId])
            .map((row): [string, FileBase] => [
              text(row.path_key),
              {
                path: text(row.path),
                sha256: text(row.sha256),
                size: nullableNumber(row.size) ?? 0,
                mtimeMs: nullableNumber(row.mtime_ms) ?? 0,
              },
            ]),
        ),
      put: (key, entry) =>
        this.db.run(
          `INSERT INTO project_file_base (project_id, path_key, path, sha256, size, mtime_ms) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, path_key) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256,
             size = excluded.size, mtime_ms = excluded.mtime_ms`,
          [projectId, key, entry.path, entry.sha256, entry.size, entry.mtimeMs],
        ),
      drop: (key) => {
        this.db.run("DELETE FROM project_file_base WHERE project_id = ? AND path_key = ?", [projectId, key]);
        this.db.run("DELETE FROM project_file_base_text WHERE project_id = ? AND path_key = ?", [projectId, key]);
      },
      text: (key) => {
        const row = this.db.get("SELECT content FROM project_file_base_text WHERE project_id = ? AND path_key = ?", [projectId, key]);
        return typeof row?.content === "string" ? row.content : null;
      },
      putText: (key, content) => {
        if (content === null) this.db.run("DELETE FROM project_file_base_text WHERE project_id = ? AND path_key = ?", [projectId, key]);
        else
          this.db.run(
            `INSERT INTO project_file_base_text (project_id, path_key, content) VALUES (?, ?, ?)
             ON CONFLICT(project_id, path_key) DO UPDATE SET content = excluded.content`,
            [projectId, key, content],
          );
      },
    };
  }

  /** Forget what both sides last agreed on: the next round treats every file as new on both sides. */
  clearFileBase(projectId: string): void {
    this.db.run("DELETE FROM project_file_base WHERE project_id = ?", [projectId]);
    this.db.run("DELETE FROM project_file_base_text WHERE project_id = ?", [projectId]);
  }

  reviewBase(projectId: string): ReviewBaseStore {
    return {
      entries: () =>
        new Map(
          this.db
            .all("SELECT * FROM project_review_base WHERE project_id = ?", [projectId])
            .map((row): [string, ReviewBase] => [
              text(row.path),
              {
                path: text(row.path),
                sha256: text(row.sha256),
                size: nullableNumber(row.size) ?? 0,
                mtimeMs: nullableNumber(row.mtime_ms) ?? 0,
                content: typeof row.content === "string" ? row.content : null,
              },
            ]),
        ),
      put: (path, entry) =>
        this.db.run(
          `INSERT INTO project_review_base (project_id, path, sha256, size, mtime_ms, content) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, path) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size,
             mtime_ms = excluded.mtime_ms, content = excluded.content`,
          [projectId, path, entry.sha256, entry.size, entry.mtimeMs, entry.content],
        ),
      drop: (path) => this.db.run("DELETE FROM project_review_base WHERE project_id = ? AND path = ?", [projectId, path]),
    };
  }

  remoteIndex(projectId: string): RemoteFileIndex {
    const key = (file: RemoteProjectFile) => file.path.toLowerCase();
    const put = (file: RemoteProjectFile) =>
      this.db.run(
        `INSERT INTO project_remote_files (project_id, path_key, file_json) VALUES (?, ?, ?)
         ON CONFLICT(project_id, path_key) DO UPDATE SET file_json = excluded.file_json`,
        [projectId, key(file), JSON.stringify(file)],
      );
    const setSeq = (seq: number | null) => {
      if (seq === null) this.db.run("DELETE FROM project_remote_seq WHERE project_id = ?", [projectId]);
      else this.db.run("INSERT INTO project_remote_seq (project_id, seq) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET seq = excluded.seq", [projectId, seq]);
    };
    const atomically = (change: () => void) => {
      this.db.exec("BEGIN");
      try {
        change();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    };
    const clear = () => {
      this.db.run("DELETE FROM project_remote_files WHERE project_id = ?", [projectId]);
      setSeq(null);
    };
    return {
      seq: () => nullableNumber(this.db.get("SELECT seq FROM project_remote_seq WHERE project_id = ?", [projectId])?.seq),
      files: () =>
        this.db
          .all("SELECT file_json FROM project_remote_files WHERE project_id = ?", [projectId])
          .flatMap((row) => {
            const parsed = remoteFileSchema.safeParse(jsonOf(text(row.file_json)));
            return parsed.success ? [parsed.data] : [];
          }),
      replace: (files, seq) =>
        atomically(() => {
          clear();
          for (const file of files) put(file);
          setSeq(seq);
        }),
      apply: (changes) =>
        atomically(() => {
          for (const path of changes.removed) this.db.run("DELETE FROM project_remote_files WHERE project_id = ? AND path_key = ?", [projectId, path.toLowerCase()]);
          for (const file of changes.files) put(file);
          setSeq(changes.seq);
        }),
      clear: () => atomically(clear),
    };
  }

  clearReviewBase(projectId: string): void {
    this.db.run("DELETE FROM project_review_base WHERE project_id = ?", [projectId]);
  }

  conflicts(projectId: string): ProjectSyncConflict[] {
    return this.db
      .all("SELECT * FROM project_conflicts WHERE project_id = ? ORDER BY created_at DESC", [projectId])
      .map((row) => ({
        path: text(row.path),
        copyPath: text(row.copy_path),
        at: new Date(nullableNumber(row.created_at) ?? 0).toISOString(),
      }));
  }

  addConflict(projectId: string, path: string, copyPath: string, now: number = Date.now()): void {
    this.db.run(
      "INSERT OR REPLACE INTO project_conflicts (project_id, path, copy_path, created_at) VALUES (?, ?, ?, ?)",
      [projectId, path, copyPath, now],
    );
  }

  dismissConflict(projectId: string, copyPath: string): void {
    this.db.run("DELETE FROM project_conflicts WHERE project_id = ? AND copy_path = ?", [projectId, copyPath]);
  }

  exportedRecordings(projectId: string): Set<string> {
    return new Set(
      this.db
        .all("SELECT recording_id FROM project_recording_exports WHERE project_id = ?", [projectId])
        .map((row) => text(row.recording_id)),
    );
  }

  markRecordingExported(projectId: string, recordingId: string, now: number = Date.now()): void {
    this.db.run(
      "INSERT OR IGNORE INTO project_recording_exports (project_id, recording_id, exported_at) VALUES (?, ?, ?)",
      [projectId, recordingId, now],
    );
  }

  // --- Pull cursor and removed projects ------------------------------------------

  pullCursor(orgId: string): string | null {
    const row = this.db.get("SELECT pull_cursor FROM project_sync_state WHERE org_id = ?", [orgId]);
    return row ? nullableText(row.pull_cursor) : null;
  }

  setPullCursor(orgId: string, cursor: string | null, now: number = Date.now()): void {
    this.db.run(
      `INSERT INTO project_sync_state (org_id, pull_cursor, last_pull_at) VALUES (?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET pull_cursor = excluded.pull_cursor, last_pull_at = excluded.last_pull_at`,
      [orgId, cursor, now],
    );
  }

  isRemoved(projectId: string): boolean {
    return this.db.get("SELECT 1 AS removed FROM project_removed WHERE project_id = ?", [projectId]) !== undefined;
  }

  markRemoved(projectId: string, orgId: string, now: number = Date.now()): void {
    this.db.run("INSERT OR REPLACE INTO project_removed (project_id, org_id, removed_at) VALUES (?, ?, ?)", [projectId, orgId, now]);
  }

  clearRemoved(projectId: string): void {
    this.db.run("DELETE FROM project_removed WHERE project_id = ?", [projectId]);
  }

  markStopped(workspaceId: string, projectId: string, orgId: string): void {
    this.db.run("INSERT OR REPLACE INTO project_stopped (workspace_id, project_id, org_id) VALUES (?, ?, ?)", [workspaceId, projectId, orgId]);
  }

  /** The firm project this one was until its owner stopped syncing it here, in this firm; forgotten once taken. */
  takeStopped(workspaceId: string, orgId: string): string | null {
    const row = this.db.get("SELECT project_id FROM project_stopped WHERE workspace_id = ? AND org_id = ?", [workspaceId, orgId]);
    this.db.run("DELETE FROM project_stopped WHERE workspace_id = ?", [workspaceId]);
    return row ? text(row.project_id) : null;
  }

  // --- Offers: a shared project one of the member's own folders already is -------------

  offer(projectId: string): ProjectOffer | null {
    const row = this.db.get("SELECT * FROM project_offers WHERE project_id = ?", [projectId]);
    return row ? toOffer(row) : null;
  }

  /** Offers still waiting for the member, of one firm or all. */
  pendingOffers(orgId?: string): ProjectOffer[] {
    const rows = orgId
      ? this.db.all("SELECT * FROM project_offers WHERE decision IS NULL AND org_id = ?", [orgId])
      : this.db.all("SELECT * FROM project_offers WHERE decision IS NULL");
    return rows.map(toOffer);
  }

  /** Record an offer; one already decided keeps its decision. */
  saveOffer(offer: Omit<ProjectOffer, "decision">, now: number = Date.now()): void {
    this.db.run(
      `INSERT INTO project_offers (project_id, workspace_id, org_id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET workspace_id = excluded.workspace_id, name = excluded.name, owner_user_id = excluded.owner_user_id`,
      [offer.projectId, offer.workspaceId, offer.orgId, offer.name, offer.ownerUserId, now],
    );
  }

  decideOffer(projectId: string, decision: "use" | "separate"): void {
    this.db.run("UPDATE project_offers SET decision = ? WHERE project_id = ?", [decision, projectId]);
  }

  dropOffer(projectId: string): void {
    this.db.run("DELETE FROM project_offers WHERE project_id = ?", [projectId]);
  }

  /** Sign-out: nothing of the firm's project list stays behind. */
  forgetOrg(orgId: string): void {
    this.db.run("DELETE FROM project_sync_state WHERE org_id = ?", [orgId]);
    this.db.run("DELETE FROM project_removed WHERE org_id = ?", [orgId]);
    this.db.run("DELETE FROM project_offers WHERE org_id = ?", [orgId]);
  }
}

const storeByPath = new Map<string, Promise<ProjectSyncStore>>();

/** The machine's project sync store, opened once per runtime DB path. */
export function projectSyncStore(config: ServerConfig): Promise<ProjectSyncStore> {
  const path = runtimeDbPath(config);
  const existing = storeByPath.get(path);
  if (existing) return existing;
  const opened = ProjectSyncStore.open(path);
  storeByPath.set(path, opened);
  return opened;
}
