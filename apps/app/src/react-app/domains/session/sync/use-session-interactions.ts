// Requests from the selected chat and its descendants share the composer.
// Each request retains its owning session for replies and cache removal.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueries } from "@tanstack/react-query";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { Client, PendingPermission, PendingQuestion, TodoItem } from "@/app/types";
import { t } from "@/i18n";
import { unwrap } from "@/app/lib/opencode";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { describeRouteError } from "@/react-app/shell/route-workspaces";
import { acknowledgeInteraction, seedTodoState, todoKey } from "./session-sync";
import {
  permissionKey, questionKey, interactionSessionsKey, emptyInteractionSessions,
  interactionSessionIds, sortInteractionRequests, replyToPermission, replyToQuestion,
  type InteractionSessions,
} from "./interaction-state";

const emptyPendingPermissions: PendingPermission[] = [];
const emptyPendingQuestions: PendingQuestion[] = [];
const emptyTodos: TodoItem[] = [];

function combinePermissions(results: Array<{ data: PendingPermission[] | undefined }>) {
  return results.flatMap((result) => result.data ?? []).sort(sortInteractionRequests);
}
function combineQuestions(results: Array<{ data: PendingQuestion[] | undefined }>) {
  return results.flatMap((result) => result.data ?? []).sort(sortInteractionRequests);
}

export type UseSessionInteractionsInput = {
  client: Client | null;
  serverClient?: LegalworkServerClient | null;
  workspaceId: string;
  sessionId: string | null;
  workspaceRoot: string;
};

export function useSessionInteractions(input: UseSessionInteractionsInput) {
  const { client, serverClient, workspaceId, sessionId, workspaceRoot } = input;

  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  const [questionReplyBusy, setQuestionReplyBusy] = useState(false);
  const questionReplyBusyRef = useRef(false);

  const sessionsKey = useMemo(() => workspaceId ? interactionSessionsKey(workspaceId) : null, [workspaceId]);
  const sessions = useQueryCacheState<InteractionSessions>(sessionsKey, emptyInteractionSessions);
  const sessionIds = useMemo(() => interactionSessionIds(sessionId, sessions), [sessionId, sessions]);
  const permissions = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: permissionKey(workspaceId, id), enabled: false, initialData: emptyPendingPermissions,
      queryFn: () => getReactQueryClient().getQueryData<PendingPermission[]>(permissionKey(workspaceId, id)) ?? emptyPendingPermissions,
    })),
    combine: combinePermissions,
  });
  const questions = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: questionKey(workspaceId, id), enabled: false, initialData: emptyPendingQuestions,
      queryFn: () => getReactQueryClient().getQueryData<PendingQuestion[]>(questionKey(workspaceId, id)) ?? emptyPendingQuestions,
    })),
    combine: combineQuestions,
  });
  const pendingPermissions = useMemo(() => permissions.map((request) => ({
    ...request,
    sourceSession: request.sessionID !== sessionId ? {
      id: request.sessionID, title: sessions[request.sessionID]?.title || t("session.subagent"),
    } : undefined,
  })), [permissions, sessionId, sessions]);
  const pendingQuestions = useMemo(() => questions.map((request) => ({
    ...request,
    sourceSession: request.sessionID !== sessionId ? {
      id: request.sessionID, title: sessions[request.sessionID]?.title || t("session.subagent"),
    } : undefined,
  })), [questions, sessionId, sessions]);
  const todoQueryKey = useMemo(
    () => (workspaceId && sessionId ? todoKey(workspaceId, sessionId) : null),
    [sessionId, workspaceId],
  );
  const todos = useQueryCacheState<TodoItem[]>(todoQueryKey, emptyTodos);

  useEffect(() => {
    if (!client || !workspaceId || !sessionId) return;
    let cancelled = false;
    const snapshotStartedAt = Date.now();
    void client.session.todo({ sessionID: sessionId, directory: workspaceRoot || undefined }).then((result) => {
      if (!cancelled) seedTodoState(workspaceId, sessionId, unwrap(result), snapshotStartedAt);
    }).catch(() => { /* Keep the event-synced plan on a failed read. */ });
    return () => { cancelled = true; };
  }, [client, sessionId, workspaceId, workspaceRoot]);

  // One request at a time keeps parallel subagents from stacking panels over
  // the composer. Questions and approvals share the same arrival order.
  const firstPermission = pendingPermissions[0];
  const firstQuestion = pendingQuestions[0];
  const permissionFirst = firstPermission && (!firstQuestion || sortInteractionRequests(firstPermission, firstQuestion) <= 0);
  const activePermission = permissionFirst ? firstPermission : null;
  const respondPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      if (!client || !workspaceId || !sessionId) return;
      const pendingPermission = pendingPermissions.find((permission) => permission.id === requestID);
      if (!pendingPermission || permissionReplyBusyRef.current) return;
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      try {
        await replyToPermission(client, pendingPermission, reply, workspaceRoot, serverClient);
        acknowledgeInteraction(workspaceId, pendingPermission.sessionID, requestID, "permission");
      } catch (error) {
        toast.error(t("app.error_request_failed"), {
          description: describeRouteError(error),
        });
      } finally {
        permissionReplyBusyRef.current = false;
        setPermissionReplyBusy(false);
      }
    },
    [client, serverClient, pendingPermissions, sessionId, workspaceId, workspaceRoot],
  );

  const activeQuestion = permissionFirst ? null : firstQuestion ?? null;
  const respondQuestion = useCallback(
    async (requestID: string, answers: string[][]) => {
      if (!client || !workspaceId || !sessionId) return;
      const pendingQuestion = pendingQuestions.find((question) => question.id === requestID);
      if (!pendingQuestion || questionReplyBusyRef.current) return;
      questionReplyBusyRef.current = true;
      setQuestionReplyBusy(true);
      try {
        await replyToQuestion(client, pendingQuestion, answers, workspaceRoot);
        acknowledgeInteraction(workspaceId, pendingQuestion.sessionID, requestID, "question");
      } catch (error) {
        toast.error(t("app.error_request_failed"), {
          description: describeRouteError(error),
        });
      } finally {
        questionReplyBusyRef.current = false;
        setQuestionReplyBusy(false);
      }
    },
    [client, pendingQuestions, sessionId, workspaceId, workspaceRoot],
  );

  return {
    activePermission,
    permissionReplyBusy,
    respondPermission,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    todos,
  };
}
