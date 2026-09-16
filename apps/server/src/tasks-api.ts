import type { EigenweltConnection } from "./eigenwelt-connection-store.js";
import { ApiError } from "./errors.js";
import {
  ANONYMOUS_ACTOR,
  isTaskPriority,
  isTaskStatus,
  TASK_NOTE_MAX_CHARS,
  TASK_PAGE_MAX,
  type TaskActor,
  type TaskCreate,
  type TaskListParams,
  type TaskPatch,
  type TaskSessionKind,
  type TaskStatus,
} from "./task-store.js";

/**
 * Request validation for the local task routes (server.ts `/workspace/:id/tasks`),
 * and who the writes are attributed to. The routes talk to the local store
 * (task-store.ts); the platform only ever sees these writes later, replayed by
 * task-sync.ts.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in Eigenwelt member, when the firm is connected — else anonymous. */
export function taskActorOf(connection: EigenweltConnection): TaskActor {
  const account = connection.account;
  if (!account) return ANONYMOUS_ACTOR;
  return { userId: account.userId, name: account.userName, email: account.userEmail };
}

/**
 * The firm whose tasks are synced: the connected account's org. Null while
 * signed out — tasks still work, they just stay on this machine.
 */
export function connectedTaskOrgId(connection: EigenweltConnection): string | null {
  const signedIn = Boolean(connection.platformToken) || Boolean(connection.refreshToken);
  return signedIn ? connection.account?.orgId ?? null : null;
}

function parseStatus(value: unknown): TaskStatus {
  if (isTaskStatus(value)) return value;
  throw new ApiError(400, "invalid_task_status", "status must be open, in_progress, done or cancelled.");
}

/**
 * A due date as the app sends it: a calendar day (`YYYY-MM-DD`, read as local
 * midnight on this machine — the firm's own clock) or a full ISO timestamp.
 */
export function parseDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "invalid_task_due_date", "dueDate must be a date (YYYY-MM-DD), an ISO timestamp, or null.");
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) {
    const local = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (local.getMonth() !== Number(day[2]) - 1 || local.getDate() !== Number(day[3])) {
      throw new ApiError(400, "invalid_task_due_date", "dueDate names a day that does not exist.");
    }
    return local.toISOString();
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ApiError(400, "invalid_task_due_date", "dueDate must be a date (YYYY-MM-DD), an ISO timestamp, or null.");
  }
  return new Date(ms).toISOString();
}

function parseAssignee(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_task_assignee", "assigneeUserId must be a user id or null.");
  }
  return value.trim() || null;
}

/** The list filter/sort/paging params off a request's query. */
export function parseTaskListParams(search: URLSearchParams): TaskListParams {
  const params: TaskListParams = {};
  const assignee = search.get("assignee")?.trim();
  if (assignee) params.assignee = assignee;
  const status = search.get("status")?.trim();
  if (status) params.status = parseStatus(status);
  const endpointId = search.get("endpointId")?.trim();
  if (endpointId) params.endpointId = endpointId;
  const sort = search.get("sort")?.trim();
  if (sort) {
    if (sort !== "created" && sort !== "updated" && sort !== "priority") {
      throw new ApiError(400, "invalid_task_sort", "sort must be created, updated or priority.");
    }
    params.sort = sort;
  }
  const order = search.get("order")?.trim();
  if (order) {
    if (order !== "asc" && order !== "desc") {
      throw new ApiError(400, "invalid_task_order", "order must be asc or desc.");
    }
    params.order = order;
  }
  const limit = search.get("limit")?.trim();
  if (limit) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ApiError(400, "invalid_task_limit", "limit must be a positive whole number.");
    }
    params.limit = Math.min(parsed, TASK_PAGE_MAX);
  }
  const cursor = search.get("cursor")?.trim();
  if (cursor) params.cursor = cursor;
  const deleted = search.get("deleted")?.trim();
  if (deleted) {
    if (deleted !== "only" && deleted !== "include") {
      throw new ApiError(400, "invalid_task_deleted", "deleted must be only or include.");
    }
    params.deleted = deleted;
  }
  return params;
}

/**
 * A create body. Only a title is required; everything else has a default.
 * `sessionId` names the agent session filing the task (the task tools send
 * it); it is kept with the workspace the request came through.
 */
export function parseTaskCreate(body: Record<string, unknown>, workspaceId?: string): TaskCreate {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new ApiError(400, "invalid_task_title", "A task needs a title.");
  const create: TaskCreate = { title };
  if (body.sessionId !== undefined) {
    if (typeof body.sessionId !== "string" || !body.sessionId.trim() || body.sessionId.length > 200) {
      throw new ApiError(400, "invalid_task_session", "sessionId must be a session id.");
    }
    if (workspaceId) create.createdInSession = { sessionId: body.sessionId.trim(), workspaceId };
  }
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
      throw new ApiError(400, "invalid_task_id", "id must be a UUID.");
    }
    create.id = body.id.toLowerCase();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      throw new ApiError(400, "invalid_task_description", "description must be a string.");
    }
    create.description = body.description;
  }
  if (body.priority !== undefined) {
    if (!isTaskPriority(body.priority)) {
      throw new ApiError(400, "invalid_task_priority", "priority must be a whole number from 0 to 4.");
    }
    create.priority = body.priority;
  }
  if (body.dueDate !== undefined) create.dueDate = parseDueDate(body.dueDate);
  if (body.assigneeUserId !== undefined) create.assigneeUserId = parseAssignee(body.assigneeUserId);
  return create;
}

/** The body tying a session started from a task to it. */
export function parseTaskSessionLink(body: Record<string, unknown>): {
  sessionId: string;
  workspaceId: string;
  kind: TaskSessionKind;
  workflowName: string | null;
} {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!sessionId || sessionId.length > 200) {
    throw new ApiError(400, "invalid_task_session", "sessionId must be a session id.");
  }
  if (!workspaceId || workspaceId.length > 200) {
    throw new ApiError(400, "invalid_task_session", "workspaceId must be a workspace id.");
  }
  if (body.kind !== "workflow" && body.kind !== "session") {
    throw new ApiError(400, "invalid_task_session", 'kind must be "workflow" or "session".');
  }
  let workflowName: string | null = null;
  if (body.workflowName !== undefined && body.workflowName !== null) {
    if (typeof body.workflowName !== "string" || body.workflowName.length > 200) {
      throw new ApiError(400, "invalid_task_session", "workflowName must be a string.");
    }
    workflowName = body.workflowName.trim() || null;
  }
  return { sessionId, workspaceId, kind: body.kind, workflowName };
}

/** A PATCH body. Only the keys sent are applied; an empty patch is refused. */
export function parseTaskPatch(body: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      throw new ApiError(400, "invalid_task_title", "A task needs a title.");
    }
    patch.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      throw new ApiError(400, "invalid_task_description", "description must be a string.");
    }
    patch.description = body.description;
  }
  if (body.status !== undefined) patch.status = parseStatus(body.status);
  if (body.priority !== undefined) {
    if (!isTaskPriority(body.priority)) {
      throw new ApiError(400, "invalid_task_priority", "priority must be a whole number from 0 to 4.");
    }
    patch.priority = body.priority;
  }
  if (body.dueDate !== undefined) patch.dueDate = parseDueDate(body.dueDate);
  if (body.assigneeUserId !== undefined) patch.assigneeUserId = parseAssignee(body.assigneeUserId);
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || !body.note.trim()) {
      throw new ApiError(400, "invalid_task_note", "note must be a non-empty string.");
    }
    const note = body.note.trim();
    if (note.length > TASK_NOTE_MAX_CHARS) {
      throw new ApiError(400, "invalid_task_note", `note must be at most ${TASK_NOTE_MAX_CHARS} characters.`);
    }
    patch.note = note;
    // Only meaningful with a note; the app's own writes default to "member".
    if (body.noteSource !== undefined) {
      if (body.noteSource !== "member" && body.noteSource !== "agent") {
        throw new ApiError(400, "invalid_task_note_source", 'noteSource must be "member" or "agent".');
      }
      patch.noteSource = body.noteSource;
    }
  }
  if (body.lastLocalRunAt !== undefined) {
    if (body.lastLocalRunAt !== null) {
      if (typeof body.lastLocalRunAt !== "string" || !Number.isFinite(Date.parse(body.lastLocalRunAt))) {
        throw new ApiError(400, "invalid_task_run_at", "lastLocalRunAt must be an ISO timestamp or null.");
      }
      patch.lastLocalRunAt = new Date(Date.parse(body.lastLocalRunAt)).toISOString();
    } else {
      patch.lastLocalRunAt = null;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "invalid_task_patch", "Nothing to update.");
  }
  return patch;
}
