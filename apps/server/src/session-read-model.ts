import { isInternalSession } from "./native-shared-values.js";
import { z } from "zod";
import type { SessionActive, SessionInfo, SessionMessageInfo, SessionStatus } from "@opencode/client";
import { ApiError } from "./errors.js";

export const sessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number(),
    action: z.object({ reason: z.string(), provider: z.string(), title: z.string(), message: z.string(), label: z.string(), link: z.string().optional() }).optional(),
  }),
]);
export const sessionTodoSchema = z.object({ content: z.string(), status: z.string(), priority: z.string().optional() }).passthrough();
export const sessionInfoSchema = z.object({
  id: z.string(), projectID: z.string(), location: z.object({ directory: z.string() }).passthrough(),
  time: z.object({ created: z.number(), updated: z.number(), archived: z.number().optional() }).passthrough(),
}).passthrough();
export const sessionMessageSchema = z.object({
  id: z.string(), type: z.string(), time: z.object({ created: z.number() }).passthrough(),
}).passthrough();
export type SessionInfoReadModel = SessionInfo;
export type SessionMessageReadModel = SessionMessageInfo;
export type SessionTodoReadModel = z.infer<typeof sessionTodoSchema>;
export type SessionStatusReadModel = SessionStatus;
export type SessionSnapshotReadModel = { session: SessionInfo; messages: SessionMessageInfo[]; todos: SessionTodoReadModel[]; status: SessionStatus };

function validate<T>(schema: z.ZodType, value: T, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(502, "opencode_invalid_response", `OpenCode returned invalid ${label}`, { issues: result.error.issues });
  // Validate the boundary while retaining every native field, including future
  // metadata. Do not reconstruct a v1 wire message or drop native attachments.
  return value;
}
export function buildSessionList(value: SessionInfo[]): SessionInfo[] {
  return validate(z.array(sessionInfoSchema), value, "session list").filter(session => !isInternalSession(session));
}
export function buildSession(value: SessionInfo): SessionInfo { return validate(sessionInfoSchema, value, "session"); }
export function buildSessionMessages(value: SessionMessageInfo[]): SessionMessageInfo[] { return validate(z.array(sessionMessageSchema), value, "session messages"); }
export function buildSessionTodos(value: unknown): SessionTodoReadModel[] {
  const result = z.array(sessionTodoSchema).safeParse(value);
  if (!result.success) throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid session todos", { issues: result.error.issues });
  return result.data;
}
export function buildSessionStatuses(value: Record<string, SessionStatus>): Record<string, SessionStatus> {
  return validate(z.record(z.string(), sessionStatusSchema), value, "session statuses");
}

/** Todos are native tool metadata, not a second engine /todo endpoint. Empty
 * lists are meaningful. Read saved history so compaction cannot erase the UI. */
export function sessionTodos(messages: readonly SessionMessageInfo[]): SessionTodoReadModel[] | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type !== "assistant") continue;
    for (const part of [...message.content].reverse()) {
      if (part.type !== "tool" || part.name !== "todowrite" || part.state.status !== "completed") continue;
      if (part.state.metadata?.todos !== undefined) return buildSessionTodos(part.state.metadata.todos);
    }
  }
}

/** The active snapshot is authoritative after reconnect; detailed retry state
 * comes from the assistant's persisted native retry, rather than a lost event. */
export function sessionStatus(active: SessionActive | undefined, messages: readonly SessionMessageInfo[]): SessionStatus {
  if (!active) return { type: "idle" };
  const last = [...messages].reverse().find(message => message.type === "assistant");
  if (last?.type === "assistant" && last.retry && !last.time.completed && last.retry.at > Date.now()) {
    return { type: "retry", attempt: last.retry.attempt, next: last.retry.at, message: last.retry.error.message };
  }
  return { type: "busy" };
}

export function buildSessionSnapshot(input: {
  session: SessionInfo; messages: SessionMessageInfo[]; todos: SessionTodoReadModel[]; active: SessionActive | undefined;
}): SessionSnapshotReadModel {
  return { session: buildSession(input.session), messages: buildSessionMessages(input.messages), todos: buildSessionTodos(input.todos), status: sessionStatus(input.active, input.messages) };
}
