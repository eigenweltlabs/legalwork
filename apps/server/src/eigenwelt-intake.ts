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

export type IntakeTaskOrigin = "intake" | "desktop";

export type IntakeTask = {
  id: string;
  /** Triaged out of a submission, or filed from a LegalWork machine. */
  origin: IntakeTaskOrigin;
  /** Null for a task filed from LegalWork, which arrived at no address. */
  endpointId: string | null;
  endpointName: string | null;
  submissionId: string | null;
  title: string;
  description: string;
  status: IntakeTaskStatus;
  priority: IntakeTaskPriority;
  dueDate: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdByUserId: string | null;
  assignmentNote: string | null;
  workflowHubItemId: string | null;
  workflowVersion: number | null;
  cloudRunId: string | null;
  lastLocalRunAt: string | null;
  attachments: IntakeAttachment[];
  createdAt: string;
  updatedAt: string;
  /** Set while the task is in the platform's trash. */
  deletedAt: string | null;
};

export type IntakeMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
};

export type IntakeTaskNoteSource = "member" | "agent";

/** One entry of a task's history. Written by a member, or by an agent for them. */
export type IntakeTaskNote = {
  id: string;
  body: string;
  source: IntakeTaskNoteSource;
  authorUserId: string;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
};

/** `GET /tasks/:id` also returns the submission the task was triaged from and
 * the task's history. The contract does not pin the submission's shape, so it
 * is relayed through untouched. */
export type IntakeTaskDetail = { task: IntakeTask; submission: unknown; notes: IntakeTaskNote[] };

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
  /** Only tasks changed after this moment (ISO) — the sync's delta pull. */
  updatedSince?: string;
  /** Live tasks by default; "only" is the trash, "include" both. */
  deleted?: "only" | "include";
  /** Extras per task: "notes", "submission". */
  include?: ("notes" | "submission")[];
};

export type IntakeTaskPage = { tasks: IntakeTask[]; nextCursor: string | null };

/** A task as the sync pulls it: with its history and the message it came from. */
export type IntakeTaskPulled = IntakeTask & { notes: IntakeTaskNote[]; submission: unknown };

/** A delta page: the changed tasks, and the ids of changed tasks the caller
 *  may no longer see (handed away on a walled endpoint, say). */
export type IntakeTaskPullPage = { tasks: IntakeTaskPulled[]; nextCursor: string | null; hidden: string[] };

export type IntakeTaskPatch = {
  title?: string;
  description?: string;
  status?: IntakeTaskStatus;
  assigneeUserId?: string | null;
  priority?: IntakeTaskPriority;
  dueDate?: string | null;
  /** When the client made the change; the platform applies each field only
   *  if nothing newer has set it since (last-writer-wins per field). */
  changedAt?: string;
  /** Appended to the task's history; it never replaces triage's note. */
  note?: string;
  noteSource?: IntakeTaskNoteSource;
  /** The client's own id and time for the note, so a retried push appends it once. */
  noteId?: string;
  noteCreatedAt?: string;
  lastLocalRunAt?: string | null;
};

export type IntakeTaskCreate = {
  /** The client's own id: the same id sent again is the same task. */
  id?: string;
  /** Files the task on an endpoint; absent for a task filed from LegalWork. */
  endpointId?: string;
  title: string;
  description?: string;
  priority?: IntakeTaskPriority;
  dueDate?: string | null;
  assigneeUserId?: string | null;
  /** When the client filed it, for a task created offline and pushed later. */
  createdAt?: string;
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
/** One history note, as the platform caps it (TASK_NOTE_MAX_CHARS). */
export const EIGENWELT_INTAKE_MAX_NOTE_CHARS = 4_000;

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
 * Build a platform client from a stored connection, or fail with a clear 403.
 *
 * Deliberately NOT gated on the `intake` feature: the task routes serve every
 * signed-in firm, because a firm's own (desktop) tasks sync with its account
 * on any plan. `intake` only decides whether mail can arrive at the firm's
 * addresses, and the platform enforces that where it matters — its
 * `not_entitled` answers are mapped onto `intake_not_entitled` below.
 */
export function requireIntakeClient(connection: {
  platformURL: string | null;
  platformToken: string | null;
}): IntakeClient {
  // Platform traffic always targets the configured trusted platform. The stored
  // URL is display metadata from OAuth and must never become a server-side
  // fetch destination.
  const platformURL = eigenweltPlatformUrl();
  const platformToken = connection.platformToken ?? "";
  if (!platformURL || !platformToken) {
    throw new ApiError(
      403,
      "intake_not_connected",
      "Syncing tasks needs an Eigenwelt account. Sign in with Eigenwelt to enable it.",
    );
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
      // The platform never redirects an API call: a redirect is a gate turning
      // the request away (to its sign-in page, say), and following it would
      // hand back an HTML page with a 200.
      redirect: "manual",
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
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(
      502,
      "intake_redirected",
      "The Eigenwelt intake service redirected the request instead of answering it.",
    );
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
  return text ? parseJsonBody(text) : null;
}

/** A 2xx body that is not JSON came from the wrong responder (an HTML page, a
 *  proxy). It must fail, not read as "nothing there". */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      502,
      "intake_bad_response",
      "The Eigenwelt intake service sent a response LegalWork could not read.",
    );
  }
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
  const endpointId = toNullableText(value.endpointId);
  return {
    id,
    // An older platform sends no origin; a task with an endpoint arrived there.
    origin: value.origin === "desktop" || (value.origin === undefined && endpointId === null) ? "desktop" : "intake",
    endpointId,
    endpointName: toNullableText(value.endpointName),
    submissionId: toNullableText(value.submissionId),
    title: toText(value.title),
    description: toText(value.description),
    status: toStatus(value.status),
    priority: toPriority(value.priority),
    dueDate: toNullableText(value.dueDate),
    assigneeUserId: toNullableText(value.assigneeUserId),
    assigneeName: toNullableText(value.assigneeName),
    createdByUserId: toNullableText(value.createdByUserId),
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
    deletedAt: toNullableText(value.deletedAt),
  };
}

/** A task's history, oldest first, as the platform sends it. Entries without an
 * id or a body are dropped rather than shown as blank rows. */
function toTaskNotes(value: unknown): IntakeTaskNote[] {
  if (!Array.isArray(value)) return [];
  const notes: IntakeTaskNote[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = toText(entry.id);
    const body = toText(entry.body);
    if (!id || !body) continue;
    notes.push({
      id,
      body,
      source: entry.source === "agent" ? "agent" : "member",
      authorUserId: toText(entry.authorUserId),
      authorName: toNullableText(entry.authorName),
      authorEmail: toNullableText(entry.authorEmail),
      createdAt: toText(entry.createdAt),
    });
  }
  return notes;
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
// Task routes
// ---------------------------------------------------------------------------

function taskListQuery(params: IntakeTaskListParams): string {
  const query = new URLSearchParams();
  if (params.assignee) query.set("assignee", params.assignee);
  if (params.status) query.set("status", params.status);
  if (params.endpointId) query.set("endpointId", params.endpointId);
  if (params.sort) query.set("sort", params.sort);
  if (params.order) query.set("order", params.order);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.updatedSince) query.set("updatedSince", params.updatedSince);
  if (params.deleted) query.set("deleted", params.deleted);
  if (params.include?.length) query.set("include", params.include.join(","));
  const search = query.toString();
  return `/api/intake/tasks${search ? `?${search}` : ""}`;
}

export async function intakeListTasks(
  client: IntakeClient,
  params: IntakeTaskListParams = {},
): Promise<IntakeTaskPage> {
  const page = await intakePullTasks(client, params);
  return { tasks: page.tasks, nextCursor: page.nextCursor };
}

/**
 * A page of tasks with everything the sync mirrors: each task's history and
 * submission when `include` asks for them, and the `hidden` ids of a delta.
 */
export async function intakePullTasks(
  client: IntakeClient,
  params: IntakeTaskListParams = {},
): Promise<IntakeTaskPullPage> {
  const json = await intakeRequest(client, "GET", taskListQuery(params));
  const raw = isRecord(json) && Array.isArray(json.tasks) ? json.tasks : [];
  const tasks: IntakeTaskPulled[] = [];
  for (const entry of raw) {
    const task = parseIntakeTask(entry);
    if (!task) continue;
    tasks.push({
      ...task,
      notes: isRecord(entry) ? toTaskNotes(entry.notes) : [],
      submission: isRecord(entry) ? entry.submission ?? null : null,
    });
  }
  const nextCursor = isRecord(json) ? toNullableText(json.nextCursor) : null;
  const hidden =
    isRecord(json) && Array.isArray(json.hidden)
      ? json.hidden.filter((id): id is string => typeof id === "string" && id !== "")
      : [];
  return { tasks, nextCursor, hidden };
}

/** Soft: the task goes to the platform's trash; `intakeRestoreTask` brings it back. */
export async function intakeDeleteTask(client: IntakeClient, taskId: string): Promise<IntakeTask | null> {
  const json = await intakeRequest(client, "DELETE", `/api/intake/tasks/${encodeURIComponent(taskId)}`);
  return parseWrittenTask(json);
}

export async function intakeRestoreTask(client: IntakeClient, taskId: string): Promise<IntakeTask | null> {
  const json = await intakeRequest(client, "POST", `/api/intake/tasks/${encodeURIComponent(taskId)}/restore`);
  return parseWrittenTask(json);
}

/**
 * Upload ONE attachment under the client's own id. The platform keeps the id,
 * and the same upload sent again (a retry after a lost answer) comes back as
 * the attachment that already exists, so a push can never store a file twice.
 */
export async function intakeUploadAttachment(
  client: IntakeClient,
  taskId: string,
  file: { id: string; filename: string; contentType: string; bytes: Uint8Array },
): Promise<IntakeAttachment | null> {
  if (file.bytes.byteLength > EIGENWELT_INTAKE_MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "intake_too_large", `"${file.filename}" is larger than 25 MiB.`);
  }
  const form = new FormData();
  form.append("id", file.id);
  form.append("files[]", new File([file.bytes as BlobPart], file.filename, { type: file.contentType }), file.filename);
  const response = await intakeFetch(
    client,
    "POST",
    `/api/intake/tasks/${encodeURIComponent(taskId)}/attachments`,
    { body: form },
  );
  const text = await response.text();
  const json = text ? parseJsonBody(text) : null;
  const stored = isRecord(json) ? toAttachments(json.attachments) : [];
  return stored[0] ?? null;
}

export async function intakeDeleteAttachment(client: IntakeClient, taskId: string, attachmentId: string): Promise<void> {
  await intakeRequest(
    client,
    "DELETE",
    `/api/intake/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export async function intakeGetTask(client: IntakeClient, taskId: string): Promise<IntakeTaskDetail> {
  const json = await intakeRequest(client, "GET", `/api/intake/tasks/${encodeURIComponent(taskId)}`);
  const task = isRecord(json) ? parseIntakeTask(json.task) : null;
  if (!task) {
    throw new ApiError(502, "intake_request_failed", "The intake service returned an invalid task.");
  }
  return {
    task,
    submission: isRecord(json) ? json.submission ?? null : null,
    notes: isRecord(json) ? toTaskNotes(json.notes) : [],
  };
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
  return parseWrittenTask(text ? parseJsonBody(text) : null);
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
