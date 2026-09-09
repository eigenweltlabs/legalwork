import { ApiError } from "./errors.js";
import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";

/**
 * Client for the Eigenwelt platform "Intake" — the firm's shared inbox, where
 * submissions arriving at an org intake address are triaged into tasks. Every
 * call carries `Authorization: Bearer <token>` where the token is the per-firm
 * platformToken minted at sign-in; the token never leaves the server, so the
 * app and the agent tools only ever see the relayed JSON.
 *
 * Only the TASK-facing routes live here. Endpoint, API-key and submission
 * administration is browser-session-only on the platform (a desktop token can
 * never reach it), so relaying it would be dead weight that only widens what a
 * stolen desktop token could do.
 */

// Mirrors the platform's shared shapes (spec of record: Linear EIG-165).
export type IntakeTaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type IntakeTaskPriority = 0 | 1 | 2 | 3 | 4;

export type IntakeAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

export type IntakeTask = {
  id: string;
  endpointId: string;
  endpointName: string;
  submissionId: string | null;
  title: string;
  description: string;
  status: IntakeTaskStatus;
  priority: IntakeTaskPriority;
  dueDate: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assignmentNote: string | null;
  workflowHubItemId: string | null;
  workflowVersion: number | null;
  cloudRunId: string | null;
  lastLocalRunAt: string | null;
  attachments: IntakeAttachment[];
  createdAt: string;
  updatedAt: string;
};

export type IntakeMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
};

/** `GET /tasks/:id` also returns the submission the task was triaged from. The
 * contract does not pin that shape, so it is relayed through untouched. */
export type IntakeTaskDetail = { task: IntakeTask; submission: unknown };

export type IntakeTaskSort = "created" | "updated" | "priority";
export type IntakeTaskOrder = "asc" | "desc";

export type IntakeTaskListParams = {
  assignee?: string;
  status?: IntakeTaskStatus;
  endpointId?: string;
  sort?: IntakeTaskSort;
  order?: IntakeTaskOrder;
  limit?: number;
  cursor?: string;
};

export type IntakeTaskPage = { tasks: IntakeTask[]; nextCursor: string | null };

export type IntakeTaskPatch = {
  status?: IntakeTaskStatus;
  assigneeUserId?: string | null;
  priority?: IntakeTaskPriority;
  note?: string;
  lastLocalRunAt?: string | null;
};

export type IntakeTaskCreate = {
  endpointId: string;
  title: string;
  description?: string;
  assigneeUserId?: string | null;
};

/** Feature key the platform grants on plans that include Intake. */
export const EIGENWELT_INTAKE_FEATURE = "intake";

/**
 * Relay guards, mirrored client-side. The AUTHORITATIVE attachment limit is the
 * endpoint's own `maxAttachmentBytes` (the platform answers 413 `too_large`);
 * these only stop the relay from buffering an unbounded upload in memory on its
 * way to the platform.
 */
export const EIGENWELT_INTAKE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const EIGENWELT_INTAKE_MAX_UPLOAD_FILES = 20;
/** Page size cap for the task list; the platform applies its own default. */
export const EIGENWELT_INTAKE_MAX_PAGE_SIZE = 200;

const INTAKE_NOT_ENTITLED_MESSAGE =
  "Intake is not included in your firm's Eigenwelt plan. An organization admin can add it.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Entitlement + client
// ---------------------------------------------------------------------------

export type IntakeClient = { platformURL: string; platformToken: string };

/**
 * Build an intake client from a stored connection, or fail with a clear 403.
 *
 * The entitlement is checked here when the stored plan is known, so an
 * un-entitled firm never spends a round-trip (and never leaks its task list's
 * existence). When no entitlements block is stored — a legacy sign-in — the
 * platform still gates every route and its 403 `not_entitled` is mapped onto
 * the SAME `intake_not_entitled` code, so the app renders one message either
 * way.
 */
export function requireIntakeClient(connection: {
  platformURL: string | null;
  platformToken: string | null;
  entitlements: { features: string[] } | null;
}): IntakeClient {
  // Intake traffic always targets the configured trusted platform. The stored
  // URL is display metadata from OAuth and must never become a server-side
  // fetch destination.
  const platformURL = eigenweltPlatformUrl();
  const platformToken = connection.platformToken ?? "";
  if (!platformURL || !platformToken) {
    throw new ApiError(
      403,
      "intake_not_connected",
      "Intake needs an Eigenwelt subscription. Sign in with Eigenwelt to enable it.",
    );
  }
  const features = connection.entitlements?.features;
  if (features && !features.includes(EIGENWELT_INTAKE_FEATURE)) {
    throw new ApiError(403, "intake_not_entitled", INTAKE_NOT_ENTITLED_MESSAGE);
  }
  return { platformURL, platformToken };
}

// ---------------------------------------------------------------------------
// Platform intake HTTP client
// ---------------------------------------------------------------------------

type IntakeFetchInit = {
  /** Bytes routes ask for anything; JSON routes leave this at application/json. */
  accept?: string;
  body?: BodyInit;
  /** Omitted for FormData, so fetch can attach the multipart boundary itself. */
  contentType?: string;
};

async function intakeFetch(
  client: IntakeClient,
  method: string,
  path: string,
  init: IntakeFetchInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${client.platformURL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${client.platformToken}`,
        Accept: init.accept ?? "application/json",
        ...(init.contentType === undefined ? {} : { "Content-Type": init.contentType }),
      },
      body: init.body,
    });
  } catch {
    throw new ApiError(502, "intake_unreachable", "Could not reach the Eigenwelt intake service.");
  }
  if (!response.ok) throw await intakeFailure(response);
  return response;
}

async function intakeRequest(
  client: IntakeClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await intakeFetch(client, method, path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    contentType: body === undefined ? undefined : "application/json",
  });
  const text = await response.text();
  return text ? safeParseJson(text) : null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read the platform's `{ code, message }` error body, tolerating a non-JSON body. */
function errorFrom(text: string): { code: string; message: string } {
  const json = text ? safeParseJson(text) : null;
  if (isRecord(json)) {
    const code = typeof json.code === "string" ? json.code : "";
    const message =
      typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : "";
    return { code, message };
  }
  return { code: "", message: text.trim().slice(0, 500) };
}

async function intakeFailure(response: Response): Promise<ApiError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // A truncated error body still maps by status below.
  }
  const { code, message } = errorFrom(text);
  // Checked before the status switch: the plan gate is the one 403 the app
  // renders differently (an upsell rather than "you can't do that").
  if (code === "not_entitled") {
    return new ApiError(403, "intake_not_entitled", message || INTAKE_NOT_ENTITLED_MESSAGE);
  }
  switch (response.status) {
    case 400:
      return new ApiError(400, "intake_invalid_request", message || "The intake request was rejected.");
    case 401:
      return new ApiError(401, "intake_unauthorized", message || "This Eigenwelt session can no longer reach intake.");
    case 403:
      return new ApiError(403, "intake_forbidden", message || "Your firm's plan does not allow this intake action.");
    case 404:
      return new ApiError(404, "intake_not_found", message || "That intake task no longer exists.");
    case 409:
      return new ApiError(409, "intake_conflict", message || "That intake task changed since you loaded it.");
    case 413:
      return new ApiError(413, "intake_too_large", message || "That attachment is larger than this endpoint allows.");
    case 429:
      return new ApiError(429, "intake_rate_limited", message || "Too many intake requests. Please try again shortly.");
    default:
      return new ApiError(502, "intake_request_failed", message || `The intake request failed (HTTP ${response.status}).`);
  }
}

// ---------------------------------------------------------------------------
// Response parsing — field by field, so a half-shaped task never reaches the app
// ---------------------------------------------------------------------------

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function toStatus(value: unknown): IntakeTaskStatus {
  return value === "in_progress" || value === "done" || value === "cancelled" ? value : "open";
}

function toPriority(value: unknown): IntakeTaskPriority {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : 0;
}

function toAttachments(value: unknown): IntakeAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: IntakeAttachment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = toText(entry.id);
    if (!id) continue;
    attachments.push({
      id,
      filename: toText(entry.filename),
      contentType: toText(entry.contentType) || "application/octet-stream",
      size: typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : 0,
    });
  }
  return attachments;
}

/** Normalize one platform task. Returns null when it carries no id to act on. */
export function parseIntakeTask(value: unknown): IntakeTask | null {
  if (!isRecord(value)) return null;
  const id = toText(value.id);
  if (!id) return null;
  return {
    id,
    endpointId: toText(value.endpointId),
    endpointName: toText(value.endpointName),
    submissionId: toNullableText(value.submissionId),
    title: toText(value.title),
    description: toText(value.description),
    status: toStatus(value.status),
    priority: toPriority(value.priority),
    dueDate: toNullableText(value.dueDate),
    assigneeUserId: toNullableText(value.assigneeUserId),
    assigneeName: toNullableText(value.assigneeName),
    assignmentNote: toNullableText(value.assignmentNote),
    workflowHubItemId: toNullableText(value.workflowHubItemId),
    workflowVersion:
      typeof value.workflowVersion === "number" && Number.isFinite(value.workflowVersion)
        ? value.workflowVersion
        : null,
    cloudRunId: toNullableText(value.cloudRunId),
    lastLocalRunAt: toNullableText(value.lastLocalRunAt),
    attachments: toAttachments(value.attachments),
    createdAt: toText(value.createdAt),
    updatedAt: toText(value.updatedAt),
  };
}

/**
 * Read a task from a write response. The contract pins the body only for
 * `GET /tasks/:id`, so create / patch / upload accept either the bare task or a
 * `{ task }` envelope, and answer null when the platform returns neither — the
 * app refetches instead of showing a fabricated row.
 */
function parseWrittenTask(json: unknown): IntakeTask | null {
  const direct = parseIntakeTask(json);
  if (direct) return direct;
  return isRecord(json) ? parseIntakeTask(json.task) : null;
}

function parseIntakeMember(value: unknown): IntakeMember | null {
  if (!isRecord(value)) return null;
  const userId = toText(value.userId);
  if (!userId) return null;
  return {
    userId,
    name: toNullableText(value.name),
    email: toNullableText(value.email),
    role: toText(value.role),
  };
}

// ---------------------------------------------------------------------------
// Request validation (shared by the relay routes)
// ---------------------------------------------------------------------------

function parseStatusParam(value: string): IntakeTaskStatus {
  if (value === "open" || value === "in_progress" || value === "done" || value === "cancelled") {
    return value;
  }
  throw new ApiError(400, "invalid_intake_status", "status must be open, in_progress, done or cancelled.");
}

function parsePriorityValue(value: unknown): IntakeTaskPriority {
  if (value === 0 || value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new ApiError(400, "invalid_intake_priority", "priority must be a whole number from 0 to 4.");
}

/** Validate the list filter/sort/paging params off a relay request's query. */
export function parseIntakeTaskListParams(search: URLSearchParams): IntakeTaskListParams {
  const params: IntakeTaskListParams = {};
  const assignee = search.get("assignee")?.trim();
  if (assignee) params.assignee = assignee;
  const status = search.get("status")?.trim();
  if (status) params.status = parseStatusParam(status);
  const endpointId = search.get("endpointId")?.trim();
  if (endpointId) params.endpointId = endpointId;
  const sort = search.get("sort")?.trim();
  if (sort) {
    if (sort !== "created" && sort !== "updated" && sort !== "priority") {
      throw new ApiError(400, "invalid_intake_sort", "sort must be created, updated or priority.");
    }
    params.sort = sort;
  }
  const order = search.get("order")?.trim();
  if (order) {
    if (order !== "asc" && order !== "desc") {
      throw new ApiError(400, "invalid_intake_order", "order must be asc or desc.");
    }
    params.order = order;
  }
  const limit = search.get("limit")?.trim();
  if (limit) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ApiError(400, "invalid_intake_limit", "limit must be a positive whole number.");
    }
    params.limit = Math.min(parsed, EIGENWELT_INTAKE_MAX_PAGE_SIZE);
  }
  const cursor = search.get("cursor")?.trim();
  if (cursor) params.cursor = cursor;
  return params;
}

/** Validate a PATCH body. Only the keys the caller sent are forwarded. */
export function parseIntakeTaskPatch(body: Record<string, unknown>): IntakeTaskPatch {
  const patch: IntakeTaskPatch = {};
  if (body.status !== undefined) {
    patch.status = parseStatusParam(typeof body.status === "string" ? body.status : "");
  }
  // null clears the assignee; the platform's task shape allows an unassigned task.
  if (body.assigneeUserId !== undefined) {
    if (body.assigneeUserId !== null && typeof body.assigneeUserId !== "string") {
      throw new ApiError(400, "invalid_intake_assignee", "assigneeUserId must be a user id or null.");
    }
    patch.assigneeUserId = body.assigneeUserId === null ? null : body.assigneeUserId.trim() || null;
  }
  if (body.priority !== undefined) patch.priority = parsePriorityValue(body.priority);
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      throw new ApiError(400, "invalid_intake_note", "note must be a string.");
    }
    patch.note = body.note;
  }
  if (body.lastLocalRunAt !== undefined) {
    if (body.lastLocalRunAt !== null && typeof body.lastLocalRunAt !== "string") {
      throw new ApiError(400, "invalid_intake_run_at", "lastLocalRunAt must be an ISO timestamp or null.");
    }
    patch.lastLocalRunAt = body.lastLocalRunAt;
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "invalid_intake_patch", "Nothing to update.");
  }
  return patch;
}

/** Validate a create body. */
export function parseIntakeTaskCreate(body: Record<string, unknown>): IntakeTaskCreate {
  const endpointId = typeof body.endpointId === "string" ? body.endpointId.trim() : "";
  if (!endpointId) {
    throw new ApiError(400, "invalid_intake_endpoint", "endpointId is required.");
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    throw new ApiError(400, "invalid_intake_title", "title is required.");
  }
  const create: IntakeTaskCreate = { endpointId, title };
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      throw new ApiError(400, "invalid_intake_description", "description must be a string.");
    }
    create.description = body.description;
  }
  if (body.assigneeUserId !== undefined) {
    if (body.assigneeUserId !== null && typeof body.assigneeUserId !== "string") {
      throw new ApiError(400, "invalid_intake_assignee", "assigneeUserId must be a user id or null.");
    }
    create.assigneeUserId = body.assigneeUserId === null ? null : body.assigneeUserId.trim() || null;
  }
  return create;
}

// ---------------------------------------------------------------------------
// Task routes
// ---------------------------------------------------------------------------

export async function intakeListTasks(
  client: IntakeClient,
  params: IntakeTaskListParams = {},
): Promise<IntakeTaskPage> {
  const query = new URLSearchParams();
  if (params.assignee) query.set("assignee", params.assignee);
  if (params.status) query.set("status", params.status);
  if (params.endpointId) query.set("endpointId", params.endpointId);
  if (params.sort) query.set("sort", params.sort);
  if (params.order) query.set("order", params.order);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  const search = query.toString();
  const json = await intakeRequest(client, "GET", `/api/intake/tasks${search ? `?${search}` : ""}`);
  const raw = isRecord(json) && Array.isArray(json.tasks) ? json.tasks : [];
  const tasks: IntakeTask[] = [];
  for (const entry of raw) {
    const task = parseIntakeTask(entry);
    if (task) tasks.push(task);
  }
  const nextCursor = isRecord(json) ? toNullableText(json.nextCursor) : null;
  return { tasks, nextCursor };
}

export async function intakeGetTask(client: IntakeClient, taskId: string): Promise<IntakeTaskDetail> {
  const json = await intakeRequest(client, "GET", `/api/intake/tasks/${encodeURIComponent(taskId)}`);
  const task = isRecord(json) ? parseIntakeTask(json.task) : null;
  if (!task) {
    throw new ApiError(502, "intake_request_failed", "The intake service returned an invalid task.");
  }
  return { task, submission: isRecord(json) ? json.submission ?? null : null };
}

export async function intakePatchTask(
  client: IntakeClient,
  taskId: string,
  patch: IntakeTaskPatch,
): Promise<IntakeTask | null> {
  const json = await intakeRequest(client, "PATCH", `/api/intake/tasks/${encodeURIComponent(taskId)}`, patch);
  return parseWrittenTask(json);
}

export async function intakeCreateTask(
  client: IntakeClient,
  input: IntakeTaskCreate,
): Promise<IntakeTask | null> {
  const json = await intakeRequest(client, "POST", "/api/intake/tasks", input);
  return parseWrittenTask(json);
}

/**
 * Upload attachments to a task. The platform reads the multipart field `files[]`
 * and enforces the endpoint's own per-attachment limit; the caps here only keep
 * the relay from buffering an unbounded body.
 */
export async function intakeUploadAttachments(
  client: IntakeClient,
  taskId: string,
  files: File[],
): Promise<IntakeTask | null> {
  if (files.length === 0) {
    throw new ApiError(400, "invalid_intake_upload", "Attach at least one file.");
  }
  if (files.length > EIGENWELT_INTAKE_MAX_UPLOAD_FILES) {
    throw new ApiError(
      413,
      "intake_too_large",
      `At most ${EIGENWELT_INTAKE_MAX_UPLOAD_FILES} attachments can be uploaded at once.`,
    );
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > EIGENWELT_INTAKE_MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      "intake_too_large",
      `Attachments are too large to upload (${Math.round(total / 1024)} KiB; limit 25 MiB).`,
    );
  }
  const form = new FormData();
  for (const file of files) form.append("files[]", file, file.name);
  const response = await intakeFetch(
    client,
    "POST",
    `/api/intake/tasks/${encodeURIComponent(taskId)}/attachments`,
    { body: form },
  );
  const text = await response.text();
  return parseWrittenTask(text ? safeParseJson(text) : null);
}

export type IntakeAttachmentBytes = {
  bytes: ArrayBuffer;
  contentType: string;
  filename: string | null;
};

/** Download one attachment's bytes, with the platform's own name/type kept. */
export async function intakeDownloadAttachment(
  client: IntakeClient,
  taskId: string,
  attachmentId: string,
): Promise<IntakeAttachmentBytes> {
  const response = await intakeFetch(
    client,
    "GET",
    `/api/intake/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { accept: "*/*" },
  );
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const raw = match?.[1] ?? match?.[2] ?? "";
  let filename: string | null = raw || null;
  if (raw) {
    try {
      filename = decodeURIComponent(raw);
    } catch {
      // A malformed encoding is still a usable literal name.
    }
  }
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    filename,
  };
}

export async function intakeListMembers(client: IntakeClient): Promise<IntakeMember[]> {
  const json = await intakeRequest(client, "GET", "/api/intake/members");
  // The contract returns a bare array; tolerate a `{ members }` envelope too.
  const raw = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.members) ? json.members : [];
  const members: IntakeMember[] = [];
  for (const entry of raw) {
    const member = parseIntakeMember(entry);
    if (member) members.push(member);
  }
  return members;
}
