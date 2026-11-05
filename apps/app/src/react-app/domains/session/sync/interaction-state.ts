import { fieldVisible } from "../modals/native-form-panel";
import type { PermissionRequest, FormInfo, SessionMessageInfo, FormAnswer } from "@opencode/client";
import type { Part } from "@/app/lib/opencode-view";
import { readSession } from "@/app/lib/opencode-read";
import type { Client, PendingPermission, PendingQuestion } from "@/app/types";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
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
  seedInteractionSessions(workspaceId, [info]);
}

export function seedInteractionSessions(workspaceId: string, sessions: InteractionSession[]) {
  getReactQueryClient().setQueryData<InteractionSessions>(interactionSessionsKey(workspaceId), (current = {}) => {
    const changed = sessions.filter(info => current[info.id]?.title !== info.title || current[info.id]?.parentID !== info.parentID);
    if (!changed.length) return current;
    return { ...current, ...Object.fromEntries(changed.map(info => [info.id, info])) };
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
type SeedOptions = { snapshotStartedAt?: number; protocol?: "v2"; snapshot?: InteractionSnapshot };

type PermissionSeed = PermissionRequest;

function v2PermissionKind(action: string): string {
  if (action === "external_directory") return "external_directory";
  if (action.endsWith(".external_directory")) return "external_directory";
  if (action === "file.read") return "read";
  if (action === "file.edit" || action === "file.write") return "edit";
  return action;
}

function v2PermissionWithReceivedAt(permission: PermissionRequest, receivedAt: number): PendingPermission {
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
    ...(permission.source ? { tool: { messageID: permission.source.messageID, callID: permission.source.id } } : {}),
    receivedAt,
    protocol: "v2",
    v2: {
      action: permission.action,
      resources: permission.resources,
      ...(permission.save ? { save: permission.save } : {}),
    },
  };
}

export function permissionWithReceivedAt(permission:PermissionRequest,receivedAt:number):PendingPermission {return v2PermissionWithReceivedAt(permission,receivedAt);}

/** The engine's MCP permission event omits arguments. Read only its exact tool call. */
export function permissionToolInput(
  permission: PendingPermission,
  message: { info: { id: string; sessionID: string }; parts: Part[] },
): Record<string, unknown> {
  const source = permission.tool;
  if (!source || message.info.id !== source.messageID || message.info.sessionID !== permission.sessionID) {
    throw new Error("Permission tool message does not match the request.");
  }
  const part = message.parts.find(part => part.type === "tool" && part.callID === source.callID
    && part.messageID === source.messageID && part.sessionID === permission.sessionID);
  if (!part || part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") {
    throw new Error("Permission tool input is unavailable.");
  }
  return part.state.input;
}

export function questionWithReceivedAt(form:FormInfo,receivedAt:number):PendingQuestion {
 return {id:form.id,sessionID:form.sessionID,form,protocol:"v2",receivedAt,questions:form.fields.flatMap(field=>field.type==="string" || field.type==="multiselect" ? [{header:field.title ?? form.title,question:field.description ?? field.title ?? form.title,options:field.options?.map(option=>({label:option.label,description:option.description ?? ""})) ?? [],multiple:field.type==="multiselect",custom:field.custom}] : [])};
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
      if (permission.protocol === "host") return true;
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
  questions: FormInfo[],
  options: SeedOptions = {},
) {
  if (options.snapshot?.deletedSessions.has(sessionId)) return;
  const queryClient = getReactQueryClient();
  const now = Date.now();
  queryClient.setQueryData<PendingQuestion[]>(questionKey(workspaceId, sessionId), (current = []) => {
    const receivedAtById = new Map(current.map((question) => [question.id, question.receivedAt]));
    const seeded = questions.flatMap((question) =>
      question.sessionID === sessionId && !options.snapshot?.questions.has(interactionRequestKey(sessionId, question.id))
        ? [questionWithReceivedAt(question, receivedAtById.get(question.id) ?? now)] : [],
    );
    const seededIds = new Set(seeded.map((question) => question.id));
    const snapshotStartedAt = options.snapshot?.startedAt ?? options.snapshotStartedAt;
    const retained = current.filter((question) => {
      if (options.protocol && question.protocol !== options.protocol) return true;
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
      const session = await readSession(input.client,id);
      if (!input.isCurrent(id)) return;
      seedInteractionSession(input.workspaceId, session);
      input.onSessionUpdated({ sessionId: session.id, info: session });
      info = session;
    }
    id = info.parentID;
  }
}

/** A new live subscription always reconciles pending requests authoritatively. */
export async function refreshWorkspaceInteractions(input:RecoveryInput) {
 const cache=getReactQueryClient();
 const [permissions,forms]=await Promise.allSettled([input.client.permission.request.list(),input.client.form.list()]);
 if(!input.isCurrent())return;
 const ids=new Set<string>();
 if(permissions.status==="fulfilled") {
  const requests=permissions.value.data;
  for(const item of requests)ids.add(item.sessionID);
  for(const [,pending] of cache.getQueriesData<PendingPermission[]>({queryKey:["react-session-permissions",input.workspaceId]}))for(const item of pending ?? [])ids.add(item.sessionID);
  for(const id of ids)seedPermissionState(input.workspaceId,id,requests,{protocol:"v2",snapshot:input.snapshot});
 }
 if(forms.status==="fulfilled") {
  const requests=forms.value.data;
  for(const item of requests)ids.add(item.sessionID);
  for(const [,pending] of cache.getQueriesData<PendingQuestion[]>({queryKey:["react-session-questions",input.workspaceId]}))for(const item of pending ?? [])ids.add(item.sessionID);
  for(const id of ids)seedQuestionState(input.workspaceId,id,requests,{protocol:"v2",snapshot:input.snapshot});
 }
 await Promise.allSettled([...ids].map(id=>resolveInteractionLineage({
  ...input,
  isCurrent:sessionID=>input.isCurrent(sessionID) && (!sessionID || !input.snapshot.deletedSessions.has(sessionID)),
 },id)));
}

export async function replyToPermission(client: Client, permission: PendingPermission, reply: "once" | "always" | "reject", directory: string, serverClient?: LegalworkServerClient | null) {
  if (permission.protocol === "host") {
    if (!serverClient?.canApprove || !permission.host || (reply === "always" && !permission.host.canRemember)) throw new Error(t("app.error_request_failed"));
    await serverClient.replyHostApproval(permission.host, reply === "once" ? "allow" : reply === "always" ? "always" : "deny");
  } else {
    await client.permission.reply({sessionID:permission.sessionID,requestID:permission.id,decision:reply});
  }
}

export async function replyToQuestion(client:Client,question:PendingQuestion,answers:string[][],_directory:string) {
 if(!question.form)throw new Error("Question form is unavailable.");
 const answer:FormAnswer={};
 for(const [index,field] of question.form.fields.entries()) {
  if(field.type!=="external" && !fieldVisible(field,question.form,answers) && !field.hidden)continue;
  const values=answers[index] ?? [];
  if(field.type==="multiselect")answer[field.key]=values;
  else if(field.type==="boolean")answer[field.key]=values[0]==="true";
  else if(field.type==="number" || field.type==="integer")answer[field.key]=Number(values[0]);
  else if(field.type==="string")answer[field.key]=values[0] ?? "";
 }
 await client.session.form.reply({sessionID:question.sessionID,formID:question.id,answer});
}
