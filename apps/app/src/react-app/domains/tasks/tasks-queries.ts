/**
 * Data access for the Tasks pane.
 *
 * Everything goes to the LegalWork server's own task store: tasks live on this
 * machine and work with no Eigenwelt account at all. When the firm is
 * connected, the server syncs the store with the account in the background;
 * the pane only learns about that through the sync status it shows. The
 * `workspaceId` in every call is transport only — tasks are the machine's,
 * which is why the pane is global and has no workspace-scoped route.
 */
import { useEffect, useRef } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  LegalworkTask,
  LegalworkTaskCreate,
  LegalworkTaskListParams,
  LegalworkTaskMember,
  LegalworkTaskPatch,
  LegalworkTaskSyncStatus,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { useEigenweltEntitlements } from "../connections/eigenwelt-entitlements";

export type TaskQueryContext = {
  client: LegalworkServerClient | null;
  workspaceId: string;
};

const TASKS_ROOT = "tasks";
const TASK_ROOT = "task";
const MEMBERS_ROOT = "task-members";
const TAGS_ROOT = "task-tags";
const SYNC_ROOT = "task-sync";

/** Filters/sort as the list request carries them (no paging keys). */
export type TaskQuery = Omit<LegalworkTaskListParams, "cursor" | "limit">;

/** One page at a time; the pane offers an explicit "load more" rather than infinite scroll. */
const PAGE_SIZE = 50;

export function tasksQueryKey(workspaceId: string, query: TaskQuery) {
  return [TASKS_ROOT, workspaceId, query] as const;
}

export function taskQueryKey(workspaceId: string, taskId: string) {
  return [TASK_ROOT, workspaceId, taskId] as const;
}

/**
 * The firm connection as the pane needs it: whether there is one (assignees
 * and sync exist only then) and who is signed in (the "assigned to me" filter
 * value). Nothing here gates the pane — tasks work without an account.
 */
export function useTaskAccess(context: TaskQueryContext) {
  const entitlementsQuery = useEigenweltEntitlements({
    client: context.client,
    workspaceId: context.workspaceId || null,
  });
  const view = entitlementsQuery.data ?? null;
  return {
    connected: Boolean(view?.connected),
    /** Clerk user id of the signed-in member — the "assigned to me" filter value. */
    accountUserId: view?.account?.userId ?? null,
  };
}

export function useTasks(context: TaskQueryContext, query: TaskQuery) {
  const { client, workspaceId } = context;
  return useInfiniteQuery({
    queryKey: tasksQueryKey(workspaceId, query),
    enabled: Boolean(client && workspaceId),
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      if (!client || !workspaceId) return { tasks: [], nextCursor: null };
      return client.listTasks(workspaceId, {
        ...query,
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useTask(context: TaskQueryContext, taskId: string | null) {
  const { client, workspaceId } = context;
  return useQuery({
    queryKey: taskQueryKey(workspaceId, taskId ?? ""),
    enabled: Boolean(client && workspaceId && taskId),
    queryFn: async () => {
      if (!client || !workspaceId || !taskId) return null;
      return client.getTask(workspaceId, taskId);
    },
  });
}

/** The firm's members for the assignee picker — cached by the server, so they
 *  are known while offline too; empty when the firm was never connected. */
export function useTaskMembers(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  return useQuery({
    queryKey: [MEMBERS_ROOT, workspaceId],
    enabled: Boolean(client && workspaceId),
    // The firm's member list changes far more slowly than its tasks.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LegalworkTaskMember[]> => {
      if (!client || !workspaceId) return [];
      return (await client.listTaskMembers(workspaceId)).members;
    },
  });
}

/** Tags already used on this machine, available even while the firm is offline. */
export function useTaskTags(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  return useQuery({
    queryKey: [TAGS_ROOT, workspaceId],
    enabled: Boolean(client && workspaceId),
    queryFn: async (): Promise<string[]> => {
      if (!client || !workspaceId) return [];
      return (await client.listTaskTags(workspaceId)).tags;
    },
  });
}

/**
 * Where the store stands against the platform. Polled, so a round that ran
 * in the background (a push landing, a pull bringing a colleague's change)
 * shows without a click: whenever the last sync moment moves, the task
 * queries are re-read.
 */
export function useTaskSyncStatus(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const queryClient = useQueryClient();
  const seenSyncAt = useRef<number | null | undefined>(undefined);
  const query = useQuery({
    queryKey: [SYNC_ROOT, workspaceId],
    enabled: Boolean(client && workspaceId),
    refetchInterval: 30_000,
    queryFn: async (): Promise<LegalworkTaskSyncStatus | null> => {
      if (!client || !workspaceId) return null;
      return client.taskSyncStatus(workspaceId);
    },
  });
  const lastSyncAt = query.data?.lastSyncAt ?? null;
  useEffect(() => {
    if (seenSyncAt.current === undefined) {
      seenSyncAt.current = lastSyncAt;
      return;
    }
    if (seenSyncAt.current === lastSyncAt) return;
    seenSyncAt.current = lastSyncAt;
    void queryClient.invalidateQueries({ queryKey: [TASKS_ROOT, workspaceId] });
    void queryClient.invalidateQueries({ queryKey: [TASK_ROOT, workspaceId] });
    void queryClient.invalidateQueries({ queryKey: [MEMBERS_ROOT, workspaceId] });
    void queryClient.invalidateQueries({ queryKey: [TAGS_ROOT, workspaceId] });
  }, [lastSyncAt, queryClient, workspaceId]);
  return query;
}

function useInvalidateTasks(context: TaskQueryContext) {
  const queryClient = useQueryClient();
  return (taskId?: string) => {
    void queryClient.invalidateQueries({ queryKey: [TASKS_ROOT, context.workspaceId] });
    void queryClient.invalidateQueries({ queryKey: [SYNC_ROOT, context.workspaceId] });
    void queryClient.invalidateQueries({ queryKey: [TAGS_ROOT, context.workspaceId] });
    if (taskId) void queryClient.invalidateQueries({ queryKey: taskQueryKey(context.workspaceId, taskId) });
  };
}

/** Push and pull now, then re-read everything the round may have changed. */
export function useRunTaskSync(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!client || !workspaceId) return null;
      return client.runTaskSync(workspaceId);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [TASKS_ROOT, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: [TASK_ROOT, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: [MEMBERS_ROOT, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: [TAGS_ROOT, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: [SYNC_ROOT, workspaceId] });
    },
  });
}

export function useCreateTask(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const invalidate = useInvalidateTasks(context);
  return useMutation({
    mutationFn: async (input: LegalworkTaskCreate): Promise<LegalworkTask> => {
      if (!client || !workspaceId) throw new Error("not connected");
      return (await client.createTask(workspaceId, input)).task;
    },
    onSuccess: () => invalidate(),
  });
}

/**
 * PATCH one task (fields, note, `lastLocalRunAt`) and refresh both the row
 * and the detail. The caches are invalidated rather than written through so
 * the list's ordering and grouping follow the store, not a guess.
 */
export function useUpdateTask(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const invalidate = useInvalidateTasks(context);
  return useMutation({
    mutationFn: async (input: { taskId: string; patch: LegalworkTaskPatch }) => {
      if (!client || !workspaceId) throw new Error("not connected");
      return client.patchTask(workspaceId, input.taskId, input.patch);
    },
    onSuccess: (_result, input) => invalidate(input.taskId),
  });
}

export function useDeleteTask(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const invalidate = useInvalidateTasks(context);
  return useMutation({
    mutationFn: async (taskId: string) => {
      if (!client || !workspaceId) throw new Error("not connected");
      return client.deleteTask(workspaceId, taskId);
    },
    onSuccess: (_result, taskId) => invalidate(taskId),
  });
}

export function useRestoreTask(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const invalidate = useInvalidateTasks(context);
  return useMutation({
    mutationFn: async (taskId: string) => {
      if (!client || !workspaceId) throw new Error("not connected");
      return client.restoreTask(workspaceId, taskId);
    },
    onSuccess: (_result, taskId) => invalidate(taskId),
  });
}

export function useUploadTaskAttachments(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const invalidate = useInvalidateTasks(context);
  return useMutation({
    mutationFn: async (input: { taskId: string; files: File[] }) => {
      if (!client || !workspaceId) throw new Error("not connected");
      return client.uploadTaskAttachments(workspaceId, input.taskId, input.files);
    },
    onSuccess: (_result, input) => invalidate(input.taskId),
  });
}

export function useDeleteTaskAttachment(context: TaskQueryContext) {
  const { client, workspaceId } = context;
  const invalidate = useInvalidateTasks(context);
  return useMutation({
    mutationFn: async (input: { taskId: string; attachmentId: string }) => {
      if (!client || !workspaceId) throw new Error("not connected");
      return client.deleteTaskAttachment(workspaceId, input.taskId, input.attachmentId);
    },
    onSuccess: (_result, input) => invalidate(input.taskId),
  });
}

/** Flatten the loaded pages into the row list the pane renders. */
export function flattenTaskPages(
  pages: Array<{ tasks: LegalworkTask[] }> | undefined,
): LegalworkTask[] {
  return (pages ?? []).flatMap((page) => page.tasks);
}
