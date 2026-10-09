import type { PermissionRequest, PermissionV2Request, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client";
import type { Client, PendingPermission, PendingQuestion } from "@/app/types";
import { unwrap } from "@/app/lib/opencode";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useSessionActivityStore } from "../status/session-activity-store";

export const permissionKey = (workspaceId: string, sessionId: string) =>
  ["react-session-permissions", workspaceId, sessionId] as const;
export const questionKey = (workspaceId: string, sessionId: string) =>
  ["react-session-questions", workspaceId, sessionId] as const;

export type InteractionSession = { id: string; parentID?: string; title: string };
export type InteractionSessions = Record<string, InteractionSession>;
export const interactionSessionsKey = (workspaceId: string) => ["react-interaction-sessions", workspaceId];
export const emptyInteractionSessions: InteractionSessions = {};

export function seedInteractionSession(workspaceId: string, info: InteractionSession) {
  getReactQueryClient().setQueryData<InteractionSessions>(interactionSessionsKey(workspaceId), (current = {}) => {
    const previous = current[info.id];
    if (previous?.title === info.title && previous.parentID === info.parentID) return current;
    return { ...current, [info.id]: info };
  });
}

// Only the selected chat and its descendants may share a request surface.
// A missing parent never makes a request eligible for an unrelated chat.
export function interactionSessionIds(sessionId: string | null, sessions: InteractionSessions): string[] {
  if (!sessionId) return [];
  const result = new Set([sessionId]);
  const children = new Map<string, string[]>();
  for (const session of Object.values(sessions)) {
    if (!session.parentID) continue;
    children.set(session.parentID, [...(children.get(session.parentID) ?? []), session.id]);
  }
  const queue = [sessionId];
  for (let index = 0; index < queue.length; index++) {
    for (const id of children.get(queue[index]!) ?? []) {
      if (result.has(id)) continue;
      result.add(id);
      queue.push(id);
    }
  }
  return [...result];
}

export function removeInteractionSession(workspaceId: string, sessionId: string) {
  const queryClient = getReactQueryClient();
  const sessions = queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId)) ?? {};
  const removed = new Set(interactionSessionIds(sessionId, sessions));
  for (const id of removed) {
    queryClient.removeQueries({ queryKey: permissionKey(workspaceId, id), exact: true });
    queryClient.removeQueries({ queryKey: questionKey(workspaceId, id), exact: true });
    useSessionActivityStore.getState().removeSession(workspaceId, id);
  }
  queryClient.setQueryData<InteractionSessions>(interactionSessionsKey(workspaceId),
    Object.fromEntries(Object.entries(sessions).filter(([id]) => !removed.has(id))));
}

export const interactionRequestKey = (sessionId: string, requestId: string) => `${sessionId}\u0000${requestId}`;
export type InteractionSnapshot = {
  startedAt: number;
  permissions: Map<string, boolean>;
  questions: Map<string, boolean>;
  deletedSessions: Set<string>;
};
export const createInteractionSnapshot = (): InteractionSnapshot => ({
  startedAt: Date.now(), permissions: new Map(), questions: new Map(), deletedSessions: new Set(),
});
type SeedOptions = { snapshotStartedAt?: number; protocol?: "legacy" | "v2"; snapshot?: InteractionSnapshot };

type PermissionSeed = PermissionRequest | PermissionV2Request;

function isV2PermissionRequest(permission: PermissionSeed): permission is PermissionV2Request {
  return "action" in permission;
}

function legacyPermissionWithReceivedAt(permission: PermissionRequest, receivedAt: number): PendingPermission {
  return { ...permission, receivedAt, protocol: "legacy" };
}

function v2PermissionKind(action: string): string {
  if (action === "external_directory") return "external_directory";
  if (action.endsWith(".external_directory")) return "external_directory";
  if (action === "file.read") return "read";
  if (action === "file.edit" || action === "file.write") return "edit";
  return action;
}

function v2PermissionWithReceivedAt(permission: PermissionV2Request, receivedAt: number): PendingPermission {
  const metadata: Record<string, unknown> = {
    ...(permission.metadata ?? {}),
    action: permission.action,
  };
  if (permission.save?.length) metadata.save = permission.save.join(", ");
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    permission: v2PermissionKind(permission.action),
    patterns: permission.resources,
    metadata,
    always: permission.save ?? [],
    ...(permission.source ? { tool: { messageID: permission.source.messageID, callID: permission.source.callID } } : {}),
    receivedAt,
    protocol: "v2",
    v2: {
      action: permission.action,
      resources: permission.resources,
      ...(permission.save ? { save: permission.save } : {}),
    },
  };
}

export function permissionWithReceivedAt(permission: PermissionSeed, receivedAt: number): PendingPermission {
  return isV2PermissionRequest(permission)
    ? v2PermissionWithReceivedAt(permission, receivedAt)
    : legacyPermissionWithReceivedAt(permission, receivedAt);
}

export function questionWithReceivedAt(question: QuestionRequest, receivedAt: number, protocol: "legacy" | "v2" = "legacy"): PendingQuestion {
  return { ...question, receivedAt, protocol };
}

export function sortInteractionRequests(a: { receivedAt: number; id: string }, b: { receivedAt: number; id: string }) {
  return a.receivedAt - b.receivedAt || a.id.localeCompare(b.id);
}

export function seedPermissionState(
  workspaceId: string,
  sessionId: string,
  permissions: PermissionSeed[],
  options: SeedOptions = {},
) {
  if (options.snapshot?.deletedSessions.has(sessionId)) return;
  const queryClient = getReactQueryClient();
  const now = Date.now();
  queryClient.setQueryData<PendingPermission[]>(permissionKey(workspaceId, sessionId), (current = []) => {
    const receivedAtById = new Map(current.map((permission) => [permission.id, permission.receivedAt]));
    const seeded = permissions.flatMap((permission) =>
      permission.sessionID === sessionId && !options.snapshot?.permissions.has(interactionRequestKey(sessionId, permission.id))
        ? [permissionWithReceivedAt(permission, receivedAtById.get(permission.id) ?? now)] : [],
    );
    const seededIds = new Set(seeded.map((permission) => permission.id));
    const snapshotStartedAt = options.snapshot?.startedAt ?? options.snapshotStartedAt;
    const retained = current.filter((permission) => {
      if (options.protocol && permission.protocol !== options.protocol) return true;
      const changed = options.snapshot?.permissions.get(interactionRequestKey(sessionId, permission.id));
      if (changed === false) return false;
      return !seededIds.has(permission.id) && (changed === true ||
        (typeof snapshotStartedAt === "number" && permission.receivedAt > snapshotStartedAt));
    });
    return [...seeded, ...retained].sort(sortInteractionRequests);
  });
  useSessionActivityStore.getState().replaceWaitingRequests(workspaceId, sessionId, "permission",
    (queryClient.getQueryData<PendingPermission[]>(permissionKey(workspaceId, sessionId)) ?? []).map((item) => item.id));
}

export function seedQuestionState(
  workspaceId: string,
  sessionId: string,
  questions: QuestionRequest[],
  options: SeedOptions = {},
) {
  if (options.snapshot?.deletedSessions.has(sessionId)) return;
  const queryClient = getReactQueryClient();
  const now = Date.now();
  queryClient.setQueryData<PendingQuestion[]>(questionKey(workspaceId, sessionId), (current = []) => {
    const receivedAtById = new Map(current.map((question) => [question.id, question.receivedAt]));
    const seeded = questions.flatMap((question) =>
      question.sessionID === sessionId && !options.snapshot?.questions.has(interactionRequestKey(sessionId, question.id))
        ? [questionWithReceivedAt(question, receivedAtById.get(question.id) ?? now, options.protocol)] : [],
    );
    const seededIds = new Set(seeded.map((question) => question.id));
    const snapshotStartedAt = options.snapshot?.startedAt ?? options.snapshotStartedAt;
    const retained = current.filter((question) => {
      if (options.protocol && (question.protocol ?? "legacy") !== options.protocol) return true;
      const changed = options.snapshot?.questions.get(interactionRequestKey(sessionId, question.id));
      if (changed === false) return false;
      return !seededIds.has(question.id) && (changed === true ||
        (typeof snapshotStartedAt === "number" && question.receivedAt > snapshotStartedAt));
    });
    return [...seeded, ...retained].sort(sortInteractionRequests);
  });
  useSessionActivityStore.getState().replaceWaitingRequests(workspaceId, sessionId, "question",
    (queryClient.getQueryData<PendingQuestion[]>(questionKey(workspaceId, sessionId)) ?? []).map((item) => item.id));
}

type RecoveryInput = {
  client: Client;
  workspaceId: string;
  snapshot: InteractionSnapshot;
  isCurrent: (sessionId?: string) => boolean;
  onSessionUpdated: (update: { sessionId: string; info: Record<string, unknown> }) => void;
};

export async function resolveInteractionLineage(input: Pick<RecoveryInput, "client" | "workspaceId" | "isCurrent" | "onSessionUpdated">, sessionId: string) {
  const seen = new Set<string>();
  let id: string | undefined = sessionId;
  while (id && !seen.has(id) && input.isCurrent(id)) {
    seen.add(id);
    let info: InteractionSession | undefined = getReactQueryClient().getQueryData<InteractionSessions>(interactionSessionsKey(input.workspaceId))?.[id];
    if (!info) {
      const session: Session = unwrap(await input.client.session.get({ sessionID: id }));
      if (!input.isCurrent(id)) return;
      seedInteractionSession(input.workspaceId, session);
      input.onSessionUpdated({ sessionId: session.id, info: session });
      info = session;
    }
    id = info.parentID;
  }
}

// Recover every protocol independently. A failed endpoint must never erase
// requests from that protocol, or delay recovery from an endpoint that works.
export async function refreshWorkspaceInteractions(input: RecoveryInput) {
  const queryClient = getReactQueryClient();
  const resolveLineage = (id: string) => resolveInteractionLineage({
    ...input,
    isCurrent: (sessionId) => input.isCurrent(sessionId) && (!sessionId || !input.snapshot.deletedSessions.has(sessionId)),
  }, id);
  const recoverPermissions = async (read: () => Promise<PermissionSeed[]>, protocol: "legacy" | "v2") => {
    const requests = (await read()).filter((item) => !input.snapshot.deletedSessions.has(item.sessionID));
    if (!input.isCurrent()) return;
    const ids = new Set(requests.map((item) => item.sessionID));
    for (const [, pending] of queryClient.getQueriesData<PendingPermission[]>({ queryKey: ["react-session-permissions", input.workspaceId] })) {
      for (const item of pending ?? []) if (item.protocol === protocol) ids.add(item.sessionID);
    }
    for (const id of ids) seedPermissionState(input.workspaceId, id, requests, { protocol, snapshot: input.snapshot });
    await Promise.allSettled([...new Set(requests.map((item) => item.sessionID))].map(resolveLineage));
  };
  const recoverQuestions = async (read: () => Promise<QuestionRequest[]>, protocol: "legacy" | "v2") => {
    const requests = (await read()).filter((item) => !input.snapshot.deletedSessions.has(item.sessionID));
    if (!input.isCurrent()) return;
    const ids = new Set(requests.map((item) => item.sessionID));
    for (const [, pending] of queryClient.getQueriesData<PendingQuestion[]>({ queryKey: ["react-session-questions", input.workspaceId] })) {
      for (const item of pending ?? []) if ((item.protocol ?? "legacy") === protocol) ids.add(item.sessionID);
    }
    for (const id of ids) seedQuestionState(input.workspaceId, id, requests, { protocol, snapshot: input.snapshot });
    await Promise.allSettled([...new Set(requests.map((item) => item.sessionID))].map(resolveLineage));
  };
  await Promise.allSettled([
    recoverPermissions(async () => unwrap(await input.client.permission.list()), "legacy"),
    recoverPermissions(async () => unwrap(await input.client.v2.permission.request.list()).data, "v2"),
    recoverQuestions(async () => unwrap(await input.client.question.list()), "legacy"),
    recoverQuestions(async () => unwrap(await input.client.v2.question.request.list()).data, "v2"),
  ]);
}

export async function replyToPermission(client: Client, permission: PendingPermission, reply: "once" | "always" | "reject", directory: string) {
  if (permission.protocol === "v2") {
    const result = await client.v2.session.permission.reply({ sessionID: permission.sessionID, requestID: permission.id, reply });
    if (result.error !== undefined) unwrap(result);
  } else {
    unwrap(await client.permission.reply({ requestID: permission.id, reply, directory: directory || undefined }));
  }
}

export async function replyToQuestion(client: Client, question: PendingQuestion, answers: string[][], directory: string) {
  if (question.protocol === "v2") {
    const result = await client.v2.session.question.reply({
      sessionID: question.sessionID, requestID: question.id, questionV2Reply: { answers },
    });
    if (result.error !== undefined) unwrap(result);
  } else {
    unwrap(await client.question.reply({ requestID: question.id, answers, directory: directory || undefined }));
  }
}
