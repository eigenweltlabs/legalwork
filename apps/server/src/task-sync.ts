import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import {
  intakeCreateTask,
  intakeDeleteAttachment,
  intakeDeleteTask,
  intakeListMembers,
  intakePatchTask,
  intakePullTasks,
  intakeRestoreTask,
  intakeUploadAttachment,
  requireIntakeClient,
  type IntakeAttachment,
  type IntakeClient,
  type IntakeMember,
  type IntakeTask,
  type IntakeTaskCreate,
  type IntakeTaskListParams,
  type IntakeTaskPatch,
  type IntakeTaskPullPage,
} from "./eigenwelt-intake.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { ApiError } from "./errors.js";
import { taskStore, type Task, type TaskOutboxEntry, type TaskStore } from "./task-store.js";
import { connectedTaskOrgId } from "./tasks-api.js";
import type { ServerConfig } from "./types.js";

/**
 * Sync between the local task store (task-store.ts) and the firm's Eigenwelt
 * account. One round is: push every local write still in the outbox, in the
 * order it happened; then pull everything the platform changed since the last
 * round and take it into the store; then refresh the member list. Nothing here
 * runs unless the firm is connected, and a round that cannot reach the
 * platform leaves the outbox as it was — the next round retries.
 *
 * Attachments' bytes are NOT pulled: an intake attachment is fetched the first
 * time it is opened (the attachment route in server.ts). Local files are
 * pushed as their `attachment_add` op comes up.
 *
 * Conflicts are the platform's to settle, per field: a push carries when the
 * change was made, and the platform applies a field only when nothing newer
 * has set it since. Whatever it settled on comes back with the next pull.
 */

export type TaskSyncResult = {
  /** False when no firm is connected — nothing was attempted. */
  ran: boolean;
  orgId: string | null;
  pushed: number;
  /** Ops that did not go through this round (kept for retry, or dropped). */
  failed: number;
  pulled: number;
  hidden: number;
  /** Why the round stopped early, if it did. */
  error: string | null;
};

/** The platform calls a round makes; injectable so a test can stand in for the platform. */
export type TaskSyncPlatform = {
  createTask: (client: IntakeClient, input: IntakeTaskCreate) => Promise<IntakeTask | null>;
  patchTask: (client: IntakeClient, taskId: string, patch: IntakeTaskPatch) => Promise<IntakeTask | null>;
  deleteTask: (client: IntakeClient, taskId: string) => Promise<IntakeTask | null>;
  restoreTask: (client: IntakeClient, taskId: string) => Promise<IntakeTask | null>;
  uploadAttachment: (
    client: IntakeClient,
    taskId: string,
    file: { id: string; filename: string; contentType: string; bytes: Uint8Array },
  ) => Promise<IntakeAttachment | null>;
  deleteAttachment: (client: IntakeClient, taskId: string, attachmentId: string) => Promise<void>;
  pullTasks: (client: IntakeClient, params: IntakeTaskListParams) => Promise<IntakeTaskPullPage>;
  listMembers: (client: IntakeClient) => Promise<IntakeMember[]>;
};

const REAL_PLATFORM: TaskSyncPlatform = {
  createTask: intakeCreateTask,
  patchTask: intakePatchTask,
  deleteTask: intakeDeleteTask,
  restoreTask: intakeRestoreTask,
  uploadAttachment: intakeUploadAttachment,
  deleteAttachment: intakeDeleteAttachment,
  pullTasks: intakePullTasks,
  listMembers: intakeListMembers,
};

/** How many tasks one pull page carries; the platform caps a page at 100. */
const PULL_PAGE_SIZE = 100;
/** Pushes and pulls again this long after a local write, so a burst of edits is one round. */
const WRITE_DEBOUNCE_MS = 1_500;
/** The background cadence while the app is open. */
const TIMER_INTERVAL_MS = 5 * 60_000;

type OutboxOutcome = "retry" | "drop" | "gone" | "abort";

/**
 * What a failed push means for its op. A 404 says the platform no longer
 * shows this task to the member (or never had it) — every pending op of the
 * task is moot. A 400/413 is a write the platform will never take — dropped,
 * with the reason on the task. Auth, rate-limit and transport failures stop
 * the round: nothing else will go through either. Anything else is retried.
 */
function classify(error: unknown): OutboxOutcome {
  if (!(error instanceof ApiError)) return "retry";
  if (error.status === 404) return "gone";
  if (error.status === 400 || error.status === 413) return "drop";
  if (error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500) return "abort";
  return "retry";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One op against the platform; resolves to the platform's `updatedAt` when it answered with the task. */
async function pushOne(
  platform: TaskSyncPlatform,
  client: IntakeClient,
  store: TaskStore,
  task: Task,
  entry: TaskOutboxEntry,
): Promise<string | null> {
  const op = entry.op;
  switch (op.kind) {
    case "create": {
      const remote = await platform.createTask(client, {
        id: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: task.dueDate,
        assigneeUserId: task.assigneeUserId,
        createdAt: task.createdAt,
      });
      return remote?.updatedAt ?? null;
    }
    case "patch": {
      const remote = await platform.patchTask(client, task.id, { ...op.fields, changedAt: op.changedAt });
      return remote?.updatedAt ?? null;
    }
    case "delete":
      return (await platform.deleteTask(client, task.id))?.updatedAt ?? null;
    case "restore":
      return (await platform.restoreTask(client, task.id))?.updatedAt ?? null;
    case "note": {
      const remote = await platform.patchTask(client, task.id, {
        note: op.body,
        noteSource: op.source,
        noteId: op.noteId,
        noteCreatedAt: op.createdAt,
      });
      store.markNoteSynced(op.noteId);
      return remote?.updatedAt ?? null;
    }
    case "attachment_add": {
      const attachment = store.getAttachment(task.id, op.attachmentId);
      const bytes = attachment ? await store.readAttachment(task.id, op.attachmentId) : null;
      // Removed again before it ever left: nothing to push.
      if (!attachment || !bytes) return null;
      await platform.uploadAttachment(client, task.id, {
        id: op.attachmentId,
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes,
      });
      store.markAttachmentSynced(op.attachmentId);
      return null;
    }
    case "attachment_delete":
      await platform.deleteAttachment(client, task.id, op.attachmentId);
      return null;
    case "run_marker": {
      const remote = await platform.patchTask(client, task.id, { lastLocalRunAt: op.lastLocalRunAt });
      return remote?.updatedAt ?? null;
    }
  }
}

async function pushOutbox(
  platform: TaskSyncPlatform,
  client: IntakeClient,
  store: TaskStore,
  orgId: string,
): Promise<{ pushed: number; failed: number; abort: unknown | null }> {
  let pushed = 0;
  let failed = 0;
  let abort: unknown | null = null;
  // A task whose op just failed transiently must not have its later ops
  // pushed ahead of it — they were made on top of that change. A task the
  // platform will not take at all has nothing more to push either.
  const blocked = new Set<string>();
  // A refused write is dropped, but the member has to learn it was: the
  // reason stays on the task past the pushes that follow it, until the next
  // successful round for that task.
  const refused = new Map<string, string>();
  for (const entry of store.listOutbox()) {
    if (blocked.has(entry.taskId)) continue;
    const task = store.getTask(entry.taskId);
    if (!task) {
      // Forgotten locally (hidden by an earlier pull): nothing left to say.
      store.completeOutbox(entry.seq);
      continue;
    }
    // Synced with another firm once: its writes are not this firm's to take.
    if (task.sync.orgId !== null && task.sync.orgId !== orgId) continue;
    try {
      const remoteUpdatedAt = await pushOne(platform, client, store, task, entry);
      store.completeOutbox(entry.seq);
      store.markSynced(task.id, orgId, remoteUpdatedAt);
      pushed += 1;
    } catch (error) {
      failed += 1;
      const outcome = classify(error);
      if (outcome === "abort") {
        // The platform is not answering (or not to us): nothing further will
        // go through this round. The op waits, and the pull is not attempted.
        store.failOutbox(entry.seq, messageOf(error));
        abort = error;
        break;
      }
      if (outcome === "gone") {
        store.discardOutbox(task.id);
        refused.set(task.id, messageOf(error));
        blocked.add(task.id);
      } else if (outcome === "drop") {
        store.completeOutbox(entry.seq);
        refused.set(task.id, messageOf(error));
      } else {
        store.failOutbox(entry.seq, messageOf(error));
        blocked.add(task.id);
      }
    }
  }
  for (const [taskId, message] of refused) store.setSyncError(taskId, message);
  return { pushed, failed, abort };
}

/** A moment just before an ISO timestamp, so the next delta re-reads a task
 *  changed in the same millisecond rather than skipping it. Re-applying a
 *  task is idempotent; missing one is not. */
function justBefore(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms - 1).toISOString() : iso;
}

async function pullChanges(
  platform: TaskSyncPlatform,
  client: IntakeClient,
  store: TaskStore,
  orgId: string,
  since: string | null,
): Promise<{ pulled: number; hidden: number; cursor: string | null }> {
  let pulled = 0;
  let newest: string | null = null;
  let pageCursor: string | undefined;
  const hiddenIds = new Set<string>();
  do {
    const page = await platform.pullTasks(client, {
      ...(since === null ? {} : { updatedSince: since }),
      deleted: "include",
      include: ["notes", "submission"],
      sort: "updated",
      order: "asc",
      limit: PULL_PAGE_SIZE,
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
    });
    for (const remote of page.tasks) {
      store.applyRemoteTask(remote, orgId);
      if (newest === null || remote.updatedAt > newest) newest = remote.updatedAt;
      pulled += 1;
    }
    for (const id of page.hidden) hiddenIds.add(id);
    pageCursor = page.nextCursor ?? undefined;
  } while (pageCursor !== undefined);

  for (const id of hiddenIds) {
    if (store.getTask(id)) await store.removeTask(id);
  }
  return { pulled, hidden: hiddenIds.size, cursor: newest === null ? since : justBefore(newest) };
}

const rounds = new Map<string, Promise<TaskSyncResult>>();
const pendingRounds = new Map<string, ReturnType<typeof setTimeout>>();

function keyOf(config: ServerConfig): string {
  return process.env.LEGALWORK_RUNTIME_DB?.trim() || config.configPath?.trim() || "default";
}

/**
 * One full round, now. Concurrent callers share the round in flight rather
 * than starting a second one against the same outbox.
 */
export function runTaskSync(
  config: ServerConfig,
  options: { platform?: TaskSyncPlatform } = {},
): Promise<TaskSyncResult> {
  const key = keyOf(config);
  const inFlight = rounds.get(key);
  if (inFlight) return inFlight;
  const round = runRound(config, options.platform ?? REAL_PLATFORM).finally(() => {
    if (rounds.get(key) === round) rounds.delete(key);
  });
  rounds.set(key, round);
  return round;
}

async function runRound(config: ServerConfig, platform: TaskSyncPlatform): Promise<TaskSyncResult> {
  await ensureFreshPlatformToken(config).catch(() => null);
  const connection = await readEigenweltConnection(config);
  const orgId = connectedTaskOrgId(connection);
  const result: TaskSyncResult = { ran: false, orgId, pushed: 0, failed: 0, pulled: 0, hidden: 0, error: null };
  if (orgId === null) return result;

  const store = await taskStore(config);
  const state = store.getSyncState(orgId);
  // Signed in (again): a sign-out from before is history from here on.
  store.clearSignedOut();
  result.ran = true;
  let client: IntakeClient;
  try {
    client = requireIntakeClient(connection);
  } catch (error) {
    result.error = messageOf(error);
    store.setSyncState({ ...state, lastError: result.error });
    return result;
  }

  let cursor = state.pullCursor;
  const now = Date.now();
  try {
    const push = await pushOutbox(platform, client, store, orgId);
    result.pushed = push.pushed;
    result.failed = push.failed;
    state.lastPushAt = now;
    if (push.abort !== null) throw push.abort;

    const pull = await pullChanges(platform, client, store, orgId, cursor);
    result.pulled = pull.pulled;
    result.hidden = pull.hidden;
    cursor = pull.cursor;
    state.lastPullAt = now;

    try {
      store.replaceMembers(orgId, await platform.listMembers(client));
    } catch {
      // The cached list still names the colleagues; the next round retries.
    }
  } catch (error) {
    result.error = messageOf(error);
  }
  store.setSyncState({ ...state, pullCursor: cursor, lastError: result.error });
  return result;
}

export type TaskSignOutResult =
  /** The firm's tasks are gone from this machine; sign-out may proceed. */
  | { ok: true; removed: number }
  /** Changes made here have not reached the firm; sign-out needs the user's say-so. */
  | { ok: false; pending: number };

/**
 * What signing out means for the tasks: one last round to get every local
 * change to the firm, then the firm's tasks leave this machine (task-store
 * `forgetFirm`). Changes that still could not be pushed are the one thing
 * the user has to decide about — they are lost with the sign-out — so
 * without `force` the sign-out stops and reports how many.
 */
export async function signOutOfFirmTasks(
  config: ServerConfig,
  options: { force?: boolean; platform?: TaskSyncPlatform } = {},
): Promise<TaskSignOutResult> {
  const connection = await readEigenweltConnection(config);
  const orgId = connectedTaskOrgId(connection);
  if (orgId === null) return { ok: true, removed: 0 };
  await runTaskSync(config, { platform: options.platform }).catch(() => undefined);
  const store = await taskStore(config);
  const pending = store.pendingFor(orgId);
  if (pending > 0 && !options.force) return { ok: false, pending };
  const { tasks } = await store.forgetFirm(orgId);
  return { ok: true, removed: tasks };
}

/** A round soon, coalescing a burst of local writes into one. */
export function scheduleTaskSync(config: ServerConfig, delayMs: number = WRITE_DEBOUNCE_MS): void {
  const key = keyOf(config);
  const pending = pendingRounds.get(key);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    pendingRounds.delete(key);
    void runTaskSync(config).catch(() => undefined);
  }, delayMs);
  timer.unref?.();
  pendingRounds.set(key, timer);
}

/** Rounds in the background while the server is up. Returns the stop function. */
export function startTaskSyncTimer(config: ServerConfig, intervalMs: number = TIMER_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void runTaskSync(config).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  // The first round does not wait for the interval: a fresh start with a
  // connected firm should show the platform's tasks right away.
  scheduleTaskSync(config, 3_000);
  return () => clearInterval(timer);
}
