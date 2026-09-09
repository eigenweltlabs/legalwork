/**
 * Data access for the Tasks pane.
 *
 * Everything goes through the LegalWork server's intake relay: the platform
 * token stays on the server, so the app only ever sees relayed JSON. The
 * `workspaceId` in every call is transport only — it picks which stored firm
 * connection relays the request; intake itself is org-level, which is why the
 * pane is global and has no workspace-scoped route.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  EigenweltIntakeMember,
  EigenweltIntakeTask,
  EigenweltIntakeTaskListParams,
  EigenweltIntakeTaskPatch,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import {
  eigenweltBillingUrl,
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "../connections/eigenwelt-entitlements";

export type IntakeQueryContext = {
  client: LegalworkServerClient | null;
  workspaceId: string;
};

const TASKS_ROOT = "intake-tasks";
const TASK_ROOT = "intake-task";
const MEMBERS_ROOT = "intake-members";

/** Filters/sort as the list request carries them (no paging keys). */
export type IntakeTaskQuery = Omit<EigenweltIntakeTaskListParams, "cursor" | "limit">;

/** One page at a time; the pane offers an explicit "load more" rather than infinite scroll. */
const PAGE_SIZE = 50;

export function intakeTasksQueryKey(workspaceId: string, query: IntakeTaskQuery) {
  return [TASKS_ROOT, workspaceId, query] as const;
}

export function intakeTaskQueryKey(workspaceId: string, taskId: string) {
  return [TASK_ROOT, workspaceId, taskId] as const;
}

/**
 * Whether the Tasks surface may render at all: signed in with an Eigenwelt
 * account AND the firm's plan grants `intake`. A lapsed subscription simply
 * flips `entitled` back to false — nothing here throws.
 */
export function useIntakeAccess(context: IntakeQueryContext) {
  const entitlementsQuery = useEigenweltEntitlements({
    client: context.client,
    workspaceId: context.workspaceId || null,
  });
  const view = entitlementsQuery.data ?? null;
  return {
    loading: entitlementsQuery.isLoading,
    connected: Boolean(view?.connected),
    entitled: Boolean(view?.connected) && hasEigenweltFeature(view?.entitlements, "intake"),
    /** Clerk user id of the signed-in member — the "assigned to me" filter value. */
    accountUserId: view?.account?.userId ?? null,
    billingUrl: eigenweltBillingUrl(view?.platformURL),
  };
}

export function useIntakeTasks(context: IntakeQueryContext, query: IntakeTaskQuery, enabled: boolean) {
  const { client, workspaceId } = context;
  return useInfiniteQuery({
    queryKey: intakeTasksQueryKey(workspaceId, query),
    enabled: enabled && Boolean(client && workspaceId),
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      if (!client || !workspaceId) return { tasks: [], nextCursor: null };
      return client.intakeListTasks(workspaceId, {
        ...query,
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useIntakeTask(context: IntakeQueryContext, taskId: string | null) {
  const { client, workspaceId } = context;
  return useQuery({
    queryKey: intakeTaskQueryKey(workspaceId, taskId ?? ""),
    enabled: Boolean(client && workspaceId && taskId),
    queryFn: async () => {
      if (!client || !workspaceId || !taskId) return null;
      return client.intakeGetTask(workspaceId, taskId);
    },
  });
}

export function useIntakeMembers(context: IntakeQueryContext, enabled: boolean) {
  const { client, workspaceId } = context;
  return useQuery({
    queryKey: [MEMBERS_ROOT, workspaceId],
    enabled: enabled && Boolean(client && workspaceId),
    // The firm's member list changes far more slowly than its tasks.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<EigenweltIntakeMember[]> => {
      if (!client || !workspaceId) return [];
      return (await client.intakeListMembers(workspaceId)).members;
    },
  });
}

/**
 * PATCH one task (status, assignee, priority, note, `lastLocalRunAt`) and
 * refresh both the row and the detail. The relay answers with the updated task
 * but may answer `task: null`, so the caches are invalidated rather than
 * written through.
 */
export function useUpdateIntakeTask(context: IntakeQueryContext) {
  const { client, workspaceId } = context;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { taskId: string; patch: EigenweltIntakeTaskPatch }) => {
      if (!client || !workspaceId) throw new Error("not connected");
      return client.intakePatchTask(workspaceId, input.taskId, input.patch);
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: [TASKS_ROOT, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: intakeTaskQueryKey(workspaceId, input.taskId) });
    },
  });
}

/** Flatten the loaded pages into the row list the pane renders. */
export function flattenIntakeTaskPages(
  pages: Array<{ tasks: EigenweltIntakeTask[] }> | undefined,
): EigenweltIntakeTask[] {
  return (pages ?? []).flatMap((page) => page.tasks);
}
