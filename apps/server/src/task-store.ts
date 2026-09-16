import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

/**
 * The local task store: the firm's tasks as this machine holds them.
 *
 * Tasks live in runtime.sqlite next to the other LegalWork stores, and their
 * attachments as files beside it. A task is usable without any Eigenwelt
 * connection — created, edited, annotated, attached to, deleted and restored
 * here — and this store is what the Tasks pane and the agent's task tools read
 * and write, connected or not.
 *
 * Two origins share the tables. A `desktop` task started on this machine (by
 * the user or by an agent for them). An `intake` task arrived at the firm's
 * intake address on the platform and was pulled here so it can be worked
 * offline; its intake-only fields (endpoint, submission, triage note, cloud
 * run) are read-only mirrors. Either way every local write is recorded in
 * `task_sync_outbox` and pushed to the platform by task-sync.ts the next time
 * the firm's account is connected. Nothing here talks to the network.
 *
 * Deletes are soft: `deleted_at` is set, the row stays, and "restore" clears
 * it — an agent may delete a task, so a mistake has to be undoable.
 */

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = 0 | 1 | 2 | 3 | 4;
export type TaskOrigin = "desktop" | "intake";
export type TaskNoteSource = "member" | "agent";
export type TaskSort = "created" | "updated" | "priority";
export type TaskOrder = "asc" | "desc";

export type TaskAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Whether the bytes are on this machine. False for an intake attachment that
   *  has not been opened yet — it is fetched on first use. */
  cached: boolean;
};

/** One entry of a task's history. Written by a member, or by an agent for them. */
export type TaskNote = {
  id: string;
  body: string;
  source: TaskNoteSource;
  authorUserId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
};

export type TaskSyncInfo = {
  /** The platform org this task is (or was last) synced with; null = never synced. */
  orgId: string | null;
  /** When local and platform last agreed, ISO; null = never. */
  syncedAt: string | null;
  /** Local changes that have not reached the platform yet. */
  pending: boolean;
  /** Why the last push of this task's changes failed, if it did. */
  error: string | null;
};

export type Task = {
  id: string;
  origin: TaskOrigin;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** ISO timestamp; a date-only due date is stored as local midnight. */
  dueDate: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdByUserId: string | null;
  // Intake-only mirrors, read-only here. Null on a desktop task.
  endpointId: string | null;
  endpointName: string | null;
  submissionId: string | null;
  assignmentNote: string | null;
  workflowHubItemId: string | null;
  workflowVersion: number | null;
  cloudRunId: string | null;
  lastLocalRunAt: string | null;
  attachments: TaskAttachment[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sync: TaskSyncInfo;
  /**
   * The sessions on this machine the task is tied to, newest first: the agent
   * session that filed it, and every workflow run or session started from it.
   * Local to this machine: session content never reaches the platform, so
   * neither does which session touched a task.
   */
  sessions: TaskSessionLink[];
  /** The agent session that filed this task, when an agent did. */
  createdSession: TaskSessionLink | null;
};

/** How a task and a session are tied together. */
export type TaskSessionKind = "created" | "workflow" | "session";

export type TaskSessionLink = {
  sessionId: string;
  workspaceId: string;
  kind: TaskSessionKind;
  /** The workflow a run was started with; null for the other kinds. */
  workflowName: string | null;
  /** ISO, when the session was tied to the task. */
  startedAt: string;
};

export type TaskDetail = { task: Task; submission: unknown; notes: TaskNote[] };

export type TaskListParams = {
  assignee?: string;
  status?: TaskStatus;
  endpointId?: string;
  sort?: TaskSort;
  order?: TaskOrder;
  limit?: number;
  cursor?: string;
  /** Default: live tasks only. "only" lists the trash, "include" both. */
  deleted?: "only" | "include";
};

export type TaskPage = { tasks: Task[]; nextCursor: string | null };

export type TaskCreate = {
  /** Client-chosen id, so a retried create never duplicates. Defaults to a fresh UUID. */
  id?: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string | null;
  assigneeUserId?: string | null;
  /** The agent session filing the task, when one is. */
  createdInSession?: { sessionId: string; workspaceId: string };
};

export type TaskPatch = {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  assigneeUserId?: string | null;
  /** Appended to the task's history; never edits an earlier entry. */
  note?: string;
  noteSource?: TaskNoteSource;
  lastLocalRunAt?: string | null;
};

/** Who is acting: the signed-in Eigenwelt member when known, else anonymous. */
export type TaskActor = {
  userId: string | null;
  name: string | null;
  email: string | null;
};

export const ANONYMOUS_ACTOR: TaskActor = { userId: null, name: null, email: null };

export type TaskMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
};

/** The scalar fields a patch may change and the platform arbitrates per field. */
export type TaskScalarField = "title" | "description" | "status" | "priority" | "dueDate" | "assigneeUserId";

const SCALAR_FIELDS: TaskScalarField[] = ["title", "description", "status", "priority", "dueDate", "assigneeUserId"];

/**
 * A recorded local write, waiting to be pushed. The payload is what the push
 * needs to replay the write on the platform; `changedAt` lets the platform
 * apply last-writer-wins per field.
 */
export type TaskSyncOp =
  | { kind: "create"; changedAt: string }
  | { kind: "patch"; fields: Partial<Pick<Task, TaskScalarField>>; changedAt: string }
  | { kind: "delete"; changedAt: string }
  | { kind: "restore"; changedAt: string }
  | { kind: "note"; noteId: string; body: string; source: TaskNoteSource; createdAt: string }
  | { kind: "attachment_add"; attachmentId: string }
  | { kind: "attachment_delete"; attachmentId: string }
  | { kind: "run_marker"; lastLocalRunAt: string | null };

export type TaskOutboxEntry = {
  seq: number;
  taskId: string;
  op: TaskSyncOp;
  createdAt: number;
  attempts: number;
  lastError: string | null;
};

export type TaskSyncState = {
  orgId: string;
  /** ISO `updatedAt` watermark of the last pull; null = never pulled. */
  pullCursor: string | null;
  lastPullAt: number | null;
  lastPushAt: number | null;
  lastError: string | null;
};

/** A task as the platform sends it (its wire shape), for `applyRemoteTask`. */
export type RemoteTask = {
  id: string;
  origin: TaskOrigin;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdByUserId: string | null;
  endpointId: string | null;
  endpointName: string | null;
  submissionId: string | null;
  assignmentNote: string | null;
  workflowHubItemId: string | null;
  workflowVersion: number | null;
  cloudRunId: string | null;
  lastLocalRunAt: string | null;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
  notes: TaskNote[];
  submission: unknown;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export const TASK_TITLE_MAX_CHARS = 500;
export const TASK_DESCRIPTION_MAX_CHARS = 100_000;
export const TASK_NOTE_MAX_CHARS = 4_000;
export const TASK_PAGE_DEFAULT = 50;
export const TASK_PAGE_MAX = 200;

// ---------------------------------------------------------------------------
// SQLite, on either runtime
// ---------------------------------------------------------------------------

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

/** The few statements the store needs, over bun:sqlite (bun) or node:sqlite
 *  (Node / Electron) — better-sqlite3 is not loadable under bun. */
type SqliteHandle = {
  run: (sql: string, params?: SqlValue[]) => void;
  all: (sql: string, params?: SqlValue[]) => Row[];
  get: (sql: string, params?: SqlValue[]) => Row | undefined;
  exec: (sql: string) => void;
};

async function openSqlite(path: string): Promise<SqliteHandle> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    return {
      run: (sql, params = []) => {
        db.query(sql).run(...params);
      },
      all: (sql, params = []) => db.query(sql).all(...params) as Row[],
      get: (sql, params = []) => (db.query(sql).get(...params) as Row | null) ?? undefined,
      exec: (sql) => {
        db.exec(sql);
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  return {
    run: (sql, params = []) => {
      db.prepare(sql).run(...params);
    },
    all: (sql, params = []) => db.prepare(sql).all(...params) as Row[],
    get: (sql, params = []) => db.prepare(sql).get(...params) as Row | undefined,
    exec: (sql) => {
      db.exec(sql);
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    origin TEXT NOT NULL DEFAULT 'desktop',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 2,
    due_date TEXT,
    assignee_user_id TEXT,
    assignee_name TEXT,
    created_by_user_id TEXT,
    endpoint_id TEXT,
    endpoint_name TEXT,
    submission_id TEXT,
    submission_json TEXT,
    assignment_note TEXT,
    workflow_hub_item_id TEXT,
    workflow_version INTEGER,
    cloud_run_id TEXT,
    last_local_run_at TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    remote_org_id TEXT,
    remote_updated_at TEXT,
    synced_at INTEGER,
    sync_error TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at)",
  // The sessions a task is tied to. Its own table, apart from the task row:
  // it names only ids, so it survives the sign-out wipe and the links are
  // back when the task is pulled again.
  `CREATE TABLE IF NOT EXISTS task_sessions (
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    workflow_name TEXT,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, session_id)
  )`,
  "CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at)",
  `CREATE TABLE IF NOT EXISTS task_notes (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'member',
    author_user_id TEXT,
    author_name TEXT,
    author_email TEXT,
    created_at INTEGER NOT NULL,
    synced_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(task_id, created_at)",
  `CREATE TABLE IF NOT EXISTS task_attachments (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    cached INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    synced_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS task_attachments_task ON task_attachments(task_id)",
  `CREATE TABLE IF NOT EXISTS task_sync_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    op_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS task_sync_outbox_task ON task_sync_outbox(task_id)",
  `CREATE TABLE IF NOT EXISTS task_sync_state (
    org_id TEXT PRIMARY KEY NOT NULL,
    pull_cursor TEXT,
    last_pull_at INTEGER,
    last_push_at INTEGER,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_flags (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_members (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT,
    email TEXT,
    role TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, user_id)
  )`,
];

// Columns added after the table's first release. SQLite has no ADD COLUMN IF
// NOT EXISTS, so each ALTER runs best-effort (throws "duplicate column" once
// the column exists — ignored). Empty for now; kept for the next one.
const MIGRATION_COLUMNS: string[] = [];

/** The one flag the store keeps about the account: a sign-out happened, and no sign-in since. */
const SIGNED_OUT_FLAG = "signed_out_at";

function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.LEGALWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "runtime.sqlite");
}

/** Attachment bytes live as files next to the DB, one directory per task. */
function attachmentsDir(config: ServerConfig): string {
  return join(dirname(runtimeDbPath(config)), "task-attachments");
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "open" || value === "in_progress" || value === "done" || value === "cancelled";
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function toStatus(value: unknown): TaskStatus {
  return isTaskStatus(value) ? value : "open";
}

function toPriority(value: unknown): TaskPriority {
  return isTaskPriority(value) ? value : 2;
}

function toOrigin(value: unknown): TaskOrigin {
  return value === "intake" ? "intake" : "desktop";
}

/**
 * The ordering expression of a sort, over an alias. `priority` is not a
 * numeric sort: 0 None ranks LAST, after 4 Low, because the firm wants Urgent
 * first and nothing "more urgent than urgent" — the platform orders the same way.
 */
function sortExpression(alias: string, sort: TaskSort): string {
  switch (sort) {
    case "created":
      return `${alias}.created_at`;
    case "updated":
      return `${alias}.updated_at`;
    case "priority":
      return `CASE WHEN ${alias}.priority = 0 THEN 5 ELSE ${alias}.priority END`;
  }
}

function parseOp(json: string): TaskSyncOp | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) && typeof value.kind === "string" ? (value as TaskSyncOp) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class TaskStore {
  private constructor(
    private readonly db: SqliteHandle,
    private readonly filesDir: string,
  ) {}

  static async open(path: string, filesDir: string): Promise<TaskStore> {
    await ensureDir(dirname(path));
    const db = await openSqlite(path);
    // Several store modules hold their own connection to runtime.sqlite, so a
    // write must wait for a sibling's rather than fail at once.
    db.exec("PRAGMA busy_timeout = 5000");
    for (const statement of SCHEMA) db.exec(statement);
    for (const statement of MIGRATION_COLUMNS) {
      try {
        db.exec(statement);
      } catch {
        // column already exists
      }
    }
    // The first cut kept one link per task, the agent's filing session, in
    // task_session_links. Carry those over as "created" links, dated to the
    // task, then let the old table go.
    if (db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_session_links'", [])) {
      db.run(
        `INSERT OR IGNORE INTO task_sessions (task_id, session_id, workspace_id, kind, workflow_name, started_at)
         SELECT l.task_id, l.session_id, l.workspace_id, 'created', NULL, COALESCE(t.created_at, ?)
         FROM task_session_links l LEFT JOIN tasks t ON t.id = l.task_id`,
        [Date.now()],
      );
      db.exec("DROP TABLE task_session_links");
    }
    return new TaskStore(db, filesDir);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // the failure below is the one worth reporting
      }
      throw error;
    }
  }

  // --- Reading ---------------------------------------------------------------

  private attachmentsOf(taskIds: string[]): Map<string, TaskAttachment[]> {
    const byTask = new Map<string, TaskAttachment[]>();
    if (taskIds.length === 0) return byTask;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db.all(
      `SELECT id, task_id, filename, content_type, size, cached FROM task_attachments WHERE task_id IN (${placeholders}) ORDER BY filename, id`,
      taskIds,
    );
    for (const row of rows) {
      const taskId = text(row.task_id);
      const list = byTask.get(taskId) ?? [];
      list.push({
        id: text(row.id),
        filename: text(row.filename),
        contentType: text(row.content_type) || "application/octet-stream",
        size: nullableNumber(row.size) ?? 0,
        cached: row.cached === 1,
      });
      byTask.set(taskId, list);
    }
    return byTask;
  }

  private pendingOf(taskIds: string[]): Map<string, { pending: boolean; error: string | null }> {
    const result = new Map<string, { pending: boolean; error: string | null }>();
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db.all(
      `SELECT task_id, MAX(last_error) AS last_error FROM task_sync_outbox WHERE task_id IN (${placeholders}) GROUP BY task_id`,
      taskIds,
    );
    for (const row of rows) {
      result.set(text(row.task_id), { pending: true, error: nullableText(row.last_error) });
    }
    return result;
  }

  private sessionLinksOf(taskIds: string[]): Map<string, TaskSessionLink[]> {
    const links = new Map<string, TaskSessionLink[]>();
    if (taskIds.length === 0) return links;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db.all(
      `SELECT task_id, session_id, workspace_id, kind, workflow_name, started_at FROM task_sessions WHERE task_id IN (${placeholders}) ORDER BY started_at DESC, session_id`,
      taskIds,
    );
    for (const row of rows) {
      const taskId = text(row.task_id);
      const kind = row.kind === "workflow" || row.kind === "session" ? row.kind : "created";
      const list = links.get(taskId) ?? [];
      list.push({
        sessionId: text(row.session_id),
        workspaceId: text(row.workspace_id),
        kind,
        workflowName: nullableText(row.workflow_name),
        startedAt: iso(nullableNumber(row.started_at)) ?? new Date(0).toISOString(),
      });
      links.set(taskId, list);
    }
    return links;
  }

  /** Tie a session to a task (a run or session started from it, or the agent's filing session). */
  recordTaskSession(
    taskId: string,
    link: { sessionId: string; workspaceId: string; kind: TaskSessionKind; workflowName?: string | null },
    now: number = Date.now(),
  ): Task {
    this.requireTask(taskId);
    this.db.run(
      `INSERT INTO task_sessions (task_id, session_id, workspace_id, kind, workflow_name, started_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, session_id) DO UPDATE SET workspace_id = excluded.workspace_id, kind = excluded.kind, workflow_name = excluded.workflow_name`,
      [taskId, link.sessionId, link.workspaceId, link.kind, link.workflowName ?? null, now],
    );
    return this.requireTask(taskId);
  }

  private rowsToTasks(rows: Row[]): Task[] {
    const ids = rows.map((row) => text(row.id));
    const attachments = this.attachmentsOf(ids);
    const pending = this.pendingOf(ids);
    const sessions = this.sessionLinksOf(ids);
    return rows.map((row) => {
      const id = text(row.id);
      const outbox = pending.get(id);
      return {
        id,
        origin: toOrigin(row.origin),
        title: text(row.title),
        description: text(row.description),
        status: toStatus(row.status),
        priority: toPriority(row.priority),
        dueDate: nullableText(row.due_date),
        assigneeUserId: nullableText(row.assignee_user_id),
        assigneeName: nullableText(row.assignee_name),
        createdByUserId: nullableText(row.created_by_user_id),
        endpointId: nullableText(row.endpoint_id),
        endpointName: nullableText(row.endpoint_name),
        submissionId: nullableText(row.submission_id),
        assignmentNote: nullableText(row.assignment_note),
        workflowHubItemId: nullableText(row.workflow_hub_item_id),
        workflowVersion: nullableNumber(row.workflow_version),
        cloudRunId: nullableText(row.cloud_run_id),
        lastLocalRunAt: nullableText(row.last_local_run_at),
        attachments: attachments.get(id) ?? [],
        createdAt: iso(nullableNumber(row.created_at)) ?? new Date(0).toISOString(),
        updatedAt: iso(nullableNumber(row.updated_at)) ?? new Date(0).toISOString(),
        deletedAt: iso(nullableNumber(row.deleted_at)),
        sync: {
          orgId: nullableText(row.remote_org_id),
          syncedAt: iso(nullableNumber(row.synced_at)),
          pending: outbox?.pending ?? false,
          error: outbox?.error ?? nullableText(row.sync_error),
        },
        sessions: sessions.get(id) ?? [],
        createdSession: sessions.get(id)?.find((link) => link.kind === "created") ?? null,
      };
    });
  }

  /** One task, deleted or not; null when there is no such row. */
  getTask(id: string): Task | null {
    const row = this.db.get("SELECT * FROM tasks WHERE id = ?", [id]);
    return row ? (this.rowsToTasks([row])[0] ?? null) : null;
  }

  private requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new ApiError(404, "task_not_found", "That task does not exist.");
    return task;
  }

  getSubmission(id: string): unknown {
    const row = this.db.get("SELECT submission_json FROM tasks WHERE id = ?", [id]);
    const json = row ? nullableText(row.submission_json) : null;
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  listNotes(taskId: string): TaskNote[] {
    const rows = this.db.all(
      "SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC, id ASC",
      [taskId],
    );
    return rows.map((row) => ({
      id: text(row.id),
      body: text(row.body),
      source: row.source === "agent" ? "agent" : "member",
      authorUserId: nullableText(row.author_user_id),
      authorName: nullableText(row.author_name),
      authorEmail: nullableText(row.author_email),
      createdAt: iso(nullableNumber(row.created_at)) ?? new Date(0).toISOString(),
    }));
  }

  getDetail(id: string): TaskDetail {
    const task = this.requireTask(id);
    return { task, submission: this.getSubmission(id), notes: this.listNotes(id) };
  }

  /**
   * A page of tasks, newest first by default. Keyset paging: the cursor is the
   * last row's id, and the bound is read back from that row inside the query
   * so the ordering and the comparison are the same expression. A cursor
   * naming a row that is gone yields an empty page rather than an error.
   *
   * `orgId` narrows intake tasks to the connected firm's: a task pulled from a
   * firm the user has since signed out of is kept but not shown.
   */
  listTasks(params: TaskListParams = {}, orgId: string | null = null): TaskPage {
    const sort: TaskSort = params.sort ?? "created";
    const order: TaskOrder = params.order ?? (sort === "priority" ? "asc" : "desc");
    const limit = Math.min(Math.max(params.limit ?? TASK_PAGE_DEFAULT, 1), TASK_PAGE_MAX);
    const where: string[] = [];
    const values: SqlValue[] = [];

    if (params.deleted === "only") where.push("t.deleted_at IS NOT NULL");
    else if (params.deleted !== "include") where.push("t.deleted_at IS NULL");
    if (params.assignee) {
      where.push("t.assignee_user_id = ?");
      values.push(params.assignee);
    }
    if (params.status) {
      where.push("t.status = ?");
      values.push(params.status);
    }
    if (params.endpointId) {
      where.push("t.endpoint_id = ?");
      values.push(params.endpointId);
    }
    if (orgId) {
      where.push("(t.origin = 'desktop' OR t.remote_org_id IS NULL OR t.remote_org_id = ?)");
      values.push(orgId);
    }
    const expr = sortExpression("t", sort);
    if (params.cursor) {
      const operator = order === "asc" ? ">" : "<";
      where.push(
        `(${expr}, t.id) ${operator} (SELECT ${sortExpression("c", sort)}, c.id FROM tasks AS c WHERE c.id = ?)`,
      );
      values.push(params.cursor);
      // The subquery is empty for an unknown cursor, which SQLite treats as
      // NULL and so as no row at all — the same "empty page" the platform gives.
    }
    const direction = order === "asc" ? "ASC" : "DESC";
    const rows = this.db.all(
      `SELECT t.* FROM tasks AS t${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${expr} ${direction}, t.id ${direction} LIMIT ?`,
      [...values, limit + 1],
    );
    const page = rows.slice(0, limit);
    const tasks = this.rowsToTasks(page);
    return {
      tasks,
      nextCursor: rows.length > limit ? (tasks[tasks.length - 1]?.id ?? null) : null,
    };
  }

  /** Every endpoint the local tasks name, for the pane's filter. */
  listEndpoints(): { id: string; name: string }[] {
    const rows = this.db.all(
      "SELECT DISTINCT endpoint_id, endpoint_name FROM tasks WHERE endpoint_id IS NOT NULL AND deleted_at IS NULL ORDER BY endpoint_name",
    );
    return rows.flatMap((row) =>
      nullableText(row.endpoint_id) ? [{ id: text(row.endpoint_id), name: text(row.endpoint_name) }] : [],
    );
  }

  // --- Local writes (each one lands in the outbox) --------------------------

  private enqueue(taskId: string, op: TaskSyncOp, now: number): void {
    this.db.run("INSERT INTO task_sync_outbox (task_id, op_json, created_at) VALUES (?, ?, ?)", [
      taskId,
      JSON.stringify(op),
      now,
    ]);
  }

  createTask(input: TaskCreate, actor: TaskActor, now: number = Date.now()): Task {
    const title = input.title.trim();
    if (!title) throw new ApiError(400, "invalid_task_title", "A task needs a title.");
    if (title.length > TASK_TITLE_MAX_CHARS) {
      throw new ApiError(400, "invalid_task_title", `A title is at most ${TASK_TITLE_MAX_CHARS} characters.`);
    }
    const description = input.description ?? "";
    if (description.length > TASK_DESCRIPTION_MAX_CHARS) {
      throw new ApiError(400, "invalid_task_description", "The description is too long.");
    }
    const id = input.id?.trim() || randomUUID();
    return this.transaction(() => {
      const existing = this.getTask(id);
      // A retried create (same id) is the same task, never a second one.
      if (existing) return existing;
      this.db.run(
        `INSERT INTO tasks (id, origin, title, description, status, priority, due_date, assignee_user_id, created_by_user_id, created_at, updated_at)
         VALUES (?, 'desktop', ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          title,
          description,
          input.priority ?? 2,
          input.dueDate ?? null,
          input.assigneeUserId ?? null,
          actor.userId,
          now,
          now,
        ],
      );
      if (input.createdInSession) {
        this.db.run(
          "INSERT OR REPLACE INTO task_sessions (task_id, session_id, workspace_id, kind, workflow_name, started_at) VALUES (?, ?, ?, 'created', NULL, ?)",
          [id, input.createdInSession.sessionId, input.createdInSession.workspaceId, now],
        );
      }
      this.enqueue(id, { kind: "create", changedAt: new Date(now).toISOString() }, now);
      return this.requireTask(id);
    });
  }

  /**
   * Change a task. Only the keys present are touched; a note is appended to the
   * history in the same transaction as the change it describes. An intake
   * task's mirrored fields cannot be changed here — the platform owns them.
   */
  patchTask(id: string, patch: TaskPatch, actor: TaskActor, now: number = Date.now()): Task {
    return this.transaction(() => {
      const task = this.requireTask(id);
      const fields: Partial<Pick<Task, TaskScalarField>> = {};
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new ApiError(400, "invalid_task_title", "A task needs a title.");
        if (title.length > TASK_TITLE_MAX_CHARS) {
          throw new ApiError(400, "invalid_task_title", `A title is at most ${TASK_TITLE_MAX_CHARS} characters.`);
        }
        fields.title = title;
      }
      if (patch.description !== undefined) {
        if (patch.description.length > TASK_DESCRIPTION_MAX_CHARS) {
          throw new ApiError(400, "invalid_task_description", "The description is too long.");
        }
        fields.description = patch.description;
      }
      if (patch.status !== undefined) fields.status = patch.status;
      if (patch.priority !== undefined) fields.priority = patch.priority;
      if (patch.dueDate !== undefined) fields.dueDate = patch.dueDate;
      if (patch.assigneeUserId !== undefined) fields.assigneeUserId = patch.assigneeUserId;

      const sets: string[] = [];
      const values: SqlValue[] = [];
      const column: Record<TaskScalarField, string> = {
        title: "title",
        description: "description",
        status: "status",
        priority: "priority",
        dueDate: "due_date",
        assigneeUserId: "assignee_user_id",
      };
      for (const field of SCALAR_FIELDS) {
        if (!(field in fields)) continue;
        sets.push(`${column[field]} = ?`);
        values.push(fields[field] ?? null);
      }
      if (fields.assigneeUserId !== undefined) {
        // The name is display data; the member list fills it in when known.
        const member = fields.assigneeUserId ? this.findMember(fields.assigneeUserId) : null;
        sets.push("assignee_name = ?");
        values.push(member?.name ?? member?.email ?? null);
      }
      if (patch.lastLocalRunAt !== undefined) {
        sets.push("last_local_run_at = ?");
        values.push(patch.lastLocalRunAt);
      }
      if (sets.length === 0 && patch.note === undefined) {
        throw new ApiError(400, "invalid_task_patch", "Nothing to update.");
      }
      if (sets.length > 0) {
        sets.push("updated_at = ?");
        values.push(now);
        this.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
      }
      const changedAt = new Date(now).toISOString();
      if (Object.keys(fields).length > 0) this.enqueue(id, { kind: "patch", fields, changedAt }, now);
      if (patch.lastLocalRunAt !== undefined) {
        this.enqueue(id, { kind: "run_marker", lastLocalRunAt: patch.lastLocalRunAt }, now);
      }
      if (patch.note !== undefined) {
        this.appendNote(task.id, patch.note, patch.noteSource ?? "member", actor, now);
      }
      return this.requireTask(id);
    });
  }

  private appendNote(taskId: string, body: string, source: TaskNoteSource, actor: TaskActor, now: number): TaskNote {
    const trimmed = body.trim();
    if (!trimmed) throw new ApiError(400, "invalid_task_note", "A note must not be empty.");
    if (trimmed.length > TASK_NOTE_MAX_CHARS) {
      throw new ApiError(400, "invalid_task_note", `A note is at most ${TASK_NOTE_MAX_CHARS} characters.`);
    }
    const id = randomUUID();
    this.db.run(
      "INSERT INTO task_notes (id, task_id, body, source, author_user_id, author_name, author_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, taskId, trimmed, source, actor.userId, actor.name, actor.email, now],
    );
    this.db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", [now, taskId]);
    const createdAt = new Date(now).toISOString();
    this.enqueue(taskId, { kind: "note", noteId: id, body: trimmed, source, createdAt }, now);
    return {
      id,
      body: trimmed,
      source,
      authorUserId: actor.userId,
      authorName: actor.name,
      authorEmail: actor.email,
      createdAt,
    };
  }

  /** Soft delete: the task moves to the trash and can be restored. */
  deleteTask(id: string, now: number = Date.now()): Task {
    return this.transaction(() => {
      const task = this.requireTask(id);
      if (task.deletedAt) return task;
      this.db.run("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
      this.enqueue(id, { kind: "delete", changedAt: new Date(now).toISOString() }, now);
      return this.requireTask(id);
    });
  }

  restoreTask(id: string, now: number = Date.now()): Task {
    return this.transaction(() => {
      const task = this.requireTask(id);
      if (!task.deletedAt) return task;
      this.db.run("UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
      this.enqueue(id, { kind: "restore", changedAt: new Date(now).toISOString() }, now);
      return this.requireTask(id);
    });
  }

  // --- Attachments ------------------------------------------------------------

  private attachmentPath(taskId: string, attachmentId: string): string {
    return join(this.filesDir, taskId, attachmentId);
  }

  /** Store a file on a task. The bytes are written first, so a row never names
   *  a file that is not there. */
  async addAttachment(
    taskId: string,
    file: { filename: string; contentType: string; bytes: Uint8Array },
    options: { id?: string; now?: number; enqueue?: boolean } = {},
  ): Promise<Task> {
    this.requireTask(taskId);
    const id = options.id?.trim() || randomUUID();
    const now = options.now ?? Date.now();
    const path = this.attachmentPath(taskId, id);
    await ensureDir(dirname(path));
    await writeFile(path, file.bytes);
    this.transaction(() => {
      this.db.run(
        "INSERT OR REPLACE INTO task_attachments (id, task_id, filename, content_type, size, cached, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
        [id, taskId, file.filename || "attachment", file.contentType || "application/octet-stream", file.bytes.byteLength, now],
      );
      this.db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", [now, taskId]);
      if (options.enqueue !== false) this.enqueue(taskId, { kind: "attachment_add", attachmentId: id }, now);
    });
    return this.requireTask(taskId);
  }

  async deleteAttachment(taskId: string, attachmentId: string, now: number = Date.now()): Promise<Task> {
    this.requireTask(taskId);
    const row = this.db.get("SELECT id FROM task_attachments WHERE id = ? AND task_id = ?", [attachmentId, taskId]);
    if (!row) throw new ApiError(404, "task_attachment_not_found", "That attachment does not exist.");
    this.transaction(() => {
      this.db.run("DELETE FROM task_attachments WHERE id = ?", [attachmentId]);
      this.db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", [now, taskId]);
      // A file that never reached the platform has nothing to delete there:
      // its pending upload is withdrawn instead.
      const pendingUpload = this.listOutboxFor(taskId).find(
        (entry) => entry.op.kind === "attachment_add" && entry.op.attachmentId === attachmentId,
      );
      if (pendingUpload) this.db.run("DELETE FROM task_sync_outbox WHERE seq = ?", [pendingUpload.seq]);
      else this.enqueue(taskId, { kind: "attachment_delete", attachmentId }, now);
    });
    await rm(this.attachmentPath(taskId, attachmentId), { force: true });
    return this.requireTask(taskId);
  }

  getAttachment(taskId: string, attachmentId: string): TaskAttachment | null {
    const row = this.db.get("SELECT * FROM task_attachments WHERE id = ? AND task_id = ?", [attachmentId, taskId]);
    if (!row) return null;
    return {
      id: text(row.id),
      filename: text(row.filename),
      contentType: text(row.content_type) || "application/octet-stream",
      size: nullableNumber(row.size) ?? 0,
      cached: row.cached === 1,
    };
  }

  /** The bytes of a cached attachment; null when they are not on this machine. */
  async readAttachment(taskId: string, attachmentId: string): Promise<Uint8Array | null> {
    const attachment = this.getAttachment(taskId, attachmentId);
    if (!attachment?.cached) return null;
    try {
      return await readFile(this.attachmentPath(taskId, attachmentId));
    } catch {
      // The file went missing under us: say so rather than serve nothing.
      this.db.run("UPDATE task_attachments SET cached = 0 WHERE id = ?", [attachmentId]);
      return null;
    }
  }

  /** Keep the bytes of an attachment fetched from the platform. */
  async cacheAttachment(taskId: string, attachmentId: string, bytes: Uint8Array): Promise<void> {
    if (!this.getAttachment(taskId, attachmentId)) {
      throw new ApiError(404, "task_attachment_not_found", "That attachment does not exist.");
    }
    const path = this.attachmentPath(taskId, attachmentId);
    await ensureDir(dirname(path));
    await writeFile(path, bytes);
    this.db.run("UPDATE task_attachments SET cached = 1, size = ? WHERE id = ?", [bytes.byteLength, attachmentId]);
  }

  // --- Members (the firm's, cached for the assignee picker) -------------------

  private findMember(userId: string): TaskMember | null {
    const row = this.db.get("SELECT * FROM task_members WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", [userId]);
    return row ? { userId: text(row.user_id), name: nullableText(row.name), email: nullableText(row.email), role: text(row.role) } : null;
  }

  listMembers(orgId: string | null): TaskMember[] {
    const rows = orgId
      ? this.db.all("SELECT * FROM task_members WHERE org_id = ? ORDER BY name, email, user_id", [orgId])
      : [];
    return rows.map((row) => ({
      userId: text(row.user_id),
      name: nullableText(row.name),
      email: nullableText(row.email),
      role: text(row.role),
    }));
  }

  replaceMembers(orgId: string, members: TaskMember[], now: number = Date.now()): void {
    this.transaction(() => {
      this.db.run("DELETE FROM task_members WHERE org_id = ?", [orgId]);
      for (const member of members) {
        this.db.run(
          "INSERT INTO task_members (org_id, user_id, name, email, role, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [orgId, member.userId, member.name, member.email, member.role, now],
        );
      }
      // Names on tasks follow the member list, so a renamed colleague reads right.
      for (const member of members) {
        this.db.run("UPDATE tasks SET assignee_name = ? WHERE assignee_user_id = ?", [
          member.name ?? member.email,
          member.userId,
        ]);
      }
    });
  }

  // --- Sync primitives (task-sync.ts) -----------------------------------------

  listOutbox(limit = 200): TaskOutboxEntry[] {
    const rows = this.db.all("SELECT * FROM task_sync_outbox ORDER BY seq ASC LIMIT ?", [limit]);
    return rows.flatMap((row) => {
      const op = parseOp(text(row.op_json));
      if (!op) return [];
      return [
        {
          seq: nullableNumber(row.seq) ?? 0,
          taskId: text(row.task_id),
          op,
          createdAt: nullableNumber(row.created_at) ?? 0,
          attempts: nullableNumber(row.attempts) ?? 0,
          lastError: nullableText(row.last_error),
        },
      ];
    });
  }

  outboxSize(): number {
    const row = this.db.get("SELECT COUNT(1) AS n FROM task_sync_outbox");
    return nullableNumber(row?.n) ?? 0;
  }

  completeOutbox(seq: number): void {
    this.db.run("DELETE FROM task_sync_outbox WHERE seq = ?", [seq]);
  }

  failOutbox(seq: number, error: string): void {
    this.db.run("UPDATE task_sync_outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?", [
      error.slice(0, 500),
      seq,
    ]);
  }

  /** Drop every pending write of a task — after the platform said the task is gone for good. */
  discardOutbox(taskId: string): void {
    this.db.run("DELETE FROM task_sync_outbox WHERE task_id = ?", [taskId]);
  }

  /** The scalar fields of a task with a push still pending — the pull must not overwrite them. */
  private dirtyFields(taskId: string): { fields: Set<TaskScalarField>; deletion: boolean } {
    const fields = new Set<TaskScalarField>();
    let deletion = false;
    for (const entry of this.listOutboxFor(taskId)) {
      if (entry.op.kind === "patch") for (const field of Object.keys(entry.op.fields)) fields.add(field as TaskScalarField);
      if (entry.op.kind === "delete" || entry.op.kind === "restore") deletion = true;
    }
    return { fields, deletion };
  }

  private listOutboxFor(taskId: string): TaskOutboxEntry[] {
    const rows = this.db.all("SELECT * FROM task_sync_outbox WHERE task_id = ? ORDER BY seq ASC", [taskId]);
    return rows.flatMap((row) => {
      const op = parseOp(text(row.op_json));
      return op
        ? [{ seq: nullableNumber(row.seq) ?? 0, taskId, op, createdAt: nullableNumber(row.created_at) ?? 0, attempts: 0, lastError: null }]
        : [];
    });
  }

  /**
   * Take a task as the platform has it. A field with a local change still
   * waiting to be pushed keeps its local value (the push, and the platform's
   * per-field last-writer-wins, settle it); everything else follows the
   * platform. Notes are unioned by id, attachments follow the platform except
   * for ones still waiting to be uploaded.
   */
  applyRemoteTask(remote: RemoteTask, orgId: string, now: number = Date.now()): Task {
    return this.transaction(() => {
      const local = this.getTask(remote.id);
      const dirty = local ? this.dirtyFields(remote.id) : { fields: new Set<TaskScalarField>(), deletion: false };
      const pick = <K extends TaskScalarField>(field: K, remoteValue: Task[K]): Task[K] =>
        local && dirty.fields.has(field) ? local[field] : remoteValue;
      const deletedAt = local && dirty.deletion ? epoch(local.deletedAt) : epoch(remote.deletedAt);
      const remoteUpdated = epoch(remote.updatedAt) ?? now;
      const updatedAt = local && (dirty.fields.size > 0 || dirty.deletion) ? Math.max(epoch(local.updatedAt) ?? 0, remoteUpdated) : remoteUpdated;
      const createdAt = local ? epoch(local.createdAt) ?? now : epoch(remote.createdAt) ?? now;
      const submissionJson = remote.submission === undefined || remote.submission === null ? null : JSON.stringify(remote.submission);
      this.db.run(
        `INSERT INTO tasks (id, origin, title, description, status, priority, due_date, assignee_user_id, assignee_name, created_by_user_id,
           endpoint_id, endpoint_name, submission_id, submission_json, assignment_note, workflow_hub_item_id, workflow_version, cloud_run_id,
           last_local_run_at, created_at, updated_at, deleted_at, remote_org_id, remote_updated_at, synced_at, sync_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           origin = excluded.origin, title = excluded.title, description = excluded.description, status = excluded.status,
           priority = excluded.priority, due_date = excluded.due_date, assignee_user_id = excluded.assignee_user_id,
           assignee_name = excluded.assignee_name, created_by_user_id = excluded.created_by_user_id, endpoint_id = excluded.endpoint_id,
           endpoint_name = excluded.endpoint_name, submission_id = excluded.submission_id,
           submission_json = COALESCE(excluded.submission_json, tasks.submission_json), assignment_note = excluded.assignment_note,
           workflow_hub_item_id = excluded.workflow_hub_item_id, workflow_version = excluded.workflow_version,
           cloud_run_id = excluded.cloud_run_id, last_local_run_at = excluded.last_local_run_at, updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at, remote_org_id = excluded.remote_org_id, remote_updated_at = excluded.remote_updated_at,
           synced_at = excluded.synced_at`,
        [
          remote.id,
          remote.origin,
          pick("title", remote.title),
          pick("description", remote.description),
          pick("status", remote.status),
          pick("priority", remote.priority),
          pick("dueDate", remote.dueDate),
          pick("assigneeUserId", remote.assigneeUserId),
          local && dirty.fields.has("assigneeUserId") ? local.assigneeName : remote.assigneeName,
          remote.createdByUserId,
          remote.endpointId,
          remote.endpointName,
          remote.submissionId,
          submissionJson,
          remote.assignmentNote,
          remote.workflowHubItemId,
          remote.workflowVersion,
          remote.cloudRunId,
          remote.lastLocalRunAt,
          createdAt,
          updatedAt,
          deletedAt,
          orgId,
          remote.updatedAt,
          now,
        ],
      );

      for (const note of remote.notes) {
        this.db.run(
          `INSERT INTO task_notes (id, task_id, body, source, author_user_id, author_name, author_email, created_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET author_name = excluded.author_name, author_email = excluded.author_email, synced_at = excluded.synced_at`,
          [note.id, remote.id, note.body, note.source, note.authorUserId, note.authorName, note.authorEmail, epoch(note.createdAt) ?? now, now],
        );
      }

      const pendingUploads = new Set(
        this.listOutboxFor(remote.id).flatMap((entry) => (entry.op.kind === "attachment_add" ? [entry.op.attachmentId] : [])),
      );
      const remoteIds = new Set(remote.attachments.map((attachment) => attachment.id));
      for (const attachment of remote.attachments) {
        this.db.run(
          `INSERT INTO task_attachments (id, task_id, filename, content_type, size, cached, created_at, synced_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type, size = excluded.size, synced_at = excluded.synced_at`,
          [attachment.id, remote.id, attachment.filename, attachment.contentType, attachment.size, now, now],
        );
      }
      const localAttachments = this.db.all("SELECT id FROM task_attachments WHERE task_id = ?", [remote.id]);
      for (const row of localAttachments) {
        const id = text(row.id);
        if (remoteIds.has(id) || pendingUploads.has(id)) continue;
        this.db.run("DELETE FROM task_attachments WHERE id = ?", [id]);
        void rm(this.attachmentPath(remote.id, id), { force: true }).catch(() => undefined);
      }
      return this.requireTask(remote.id);
    });
  }

  /** After a successful push of one op: the task is as the platform has it. */
  markSynced(taskId: string, orgId: string, remoteUpdatedAt: string | null, now: number = Date.now()): void {
    this.db.run(
      "UPDATE tasks SET remote_org_id = ?, remote_updated_at = COALESCE(?, remote_updated_at), synced_at = ?, sync_error = NULL WHERE id = ?",
      [orgId, remoteUpdatedAt, now, taskId],
    );
  }

  markNoteSynced(noteId: string, now: number = Date.now()): void {
    this.db.run("UPDATE task_notes SET synced_at = ? WHERE id = ?", [now, noteId]);
  }

  markAttachmentSynced(attachmentId: string, now: number = Date.now()): void {
    this.db.run("UPDATE task_attachments SET synced_at = ? WHERE id = ?", [now, attachmentId]);
  }

  setSyncError(taskId: string, error: string | null): void {
    this.db.run("UPDATE tasks SET sync_error = ? WHERE id = ?", [error ? error.slice(0, 500) : null, taskId]);
  }

  /** Forget a task entirely — the platform no longer shows it to this member. */
  async removeTask(id: string): Promise<void> {
    this.transaction(() => {
      this.db.run("DELETE FROM task_sync_outbox WHERE task_id = ?", [id]);
      this.db.run("DELETE FROM task_notes WHERE task_id = ?", [id]);
      this.db.run("DELETE FROM task_attachments WHERE task_id = ?", [id]);
      this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
    });
    await rm(join(this.filesDir, id), { recursive: true, force: true });
  }

  /** Pending writes that would go to this firm: on tasks synced with it, or never synced at all. */
  pendingFor(orgId: string): number {
    const row = this.db.get(
      `SELECT COUNT(1) AS n FROM task_sync_outbox o JOIN tasks t ON t.id = o.task_id
       WHERE t.remote_org_id IS NULL OR t.remote_org_id = ?`,
      [orgId],
    );
    return nullableNumber(row?.n) ?? 0;
  }

  /**
   * Sign-out: the firm's data leaves this machine. Every task synced with the
   * firm — pulled from it or filed here and pushed to it — goes, with its
   * notes, attachment files, pending writes, the cached member list and the
   * pull cursor. A task that never synced stays: it is this machine's alone.
   * All that remains is the fact that a sign-out happened (nothing about the
   * firm or what went), so the pane can say so until the next sign-in.
   */
  async forgetFirm(orgId: string, now: number = Date.now()): Promise<{ tasks: number }> {
    const ids = this.db
      .all("SELECT id FROM tasks WHERE remote_org_id = ?", [orgId])
      .map((row) => text(row.id));
    this.transaction(() => {
      for (const id of ids) {
        this.db.run("DELETE FROM task_sync_outbox WHERE task_id = ?", [id]);
        this.db.run("DELETE FROM task_notes WHERE task_id = ?", [id]);
        this.db.run("DELETE FROM task_attachments WHERE task_id = ?", [id]);
        this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
      }
      this.db.run("DELETE FROM task_members WHERE org_id = ?", [orgId]);
      this.db.run("DELETE FROM task_sync_state WHERE org_id = ?", [orgId]);
      this.db.run("INSERT OR REPLACE INTO task_flags (key, value) VALUES (?, ?)", [SIGNED_OUT_FLAG, String(now)]);
    });
    for (const id of ids) await rm(join(this.filesDir, id), { recursive: true, force: true });
    return { tasks: ids.length };
  }

  /** Whether a sign-out happened and no firm has been synced since. */
  signedOutBefore(): boolean {
    return this.db.get("SELECT value FROM task_flags WHERE key = ?", [SIGNED_OUT_FLAG]) !== undefined;
  }

  /** A firm is synced again: the sign-out is history. */
  clearSignedOut(): void {
    this.db.run("DELETE FROM task_flags WHERE key = ?", [SIGNED_OUT_FLAG]);
  }

  getSyncState(orgId: string): TaskSyncState {
    const row = this.db.get("SELECT * FROM task_sync_state WHERE org_id = ?", [orgId]);
    return {
      orgId,
      pullCursor: row ? nullableText(row.pull_cursor) : null,
      lastPullAt: row ? nullableNumber(row.last_pull_at) : null,
      lastPushAt: row ? nullableNumber(row.last_push_at) : null,
      lastError: row ? nullableText(row.last_error) : null,
    };
  }

  setSyncState(state: TaskSyncState): void {
    this.db.run(
      `INSERT INTO task_sync_state (org_id, pull_cursor, last_pull_at, last_push_at, last_error) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET pull_cursor = excluded.pull_cursor, last_pull_at = excluded.last_pull_at,
         last_push_at = excluded.last_push_at, last_error = excluded.last_error`,
      [state.orgId, state.pullCursor, state.lastPullAt, state.lastPushAt, state.lastError ? state.lastError.slice(0, 500) : null],
    );
  }
}

const storeByPath = new Map<string, Promise<TaskStore>>();

/** The machine's task store, opened once per runtime DB path. */
export function taskStore(config: ServerConfig): Promise<TaskStore> {
  const path = runtimeDbPath(config);
  const existing = storeByPath.get(path);
  if (existing) return existing;
  const dir = attachmentsDir(config);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const opened = TaskStore.open(path, dir);
  storeByPath.set(path, opened);
  return opened;
}
