import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { LegalMemoryPermission } from "@legalwork/types/legalmemory";
import { legalMemoryInterfaceActivities, subscribeLegalMemoryInterfaceActivities, cancelLegalMemoryInterfaceReads, type LegalMemoryInterfaceActivity } from "@/app/lib/legalmemory-interface-activity";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

export function LegalMemoryPermissionNotice(props: { workspace: string; permission: LegalMemoryPermission; busy?: boolean; error?: string; onReply: (decision: "once" | "reject") => void }) {
  return <>
    <DialogTitle>{t("legalmemory_permission.title")}</DialogTitle>
    <DialogDescription>{t("legalmemory_permission.description", { workspace: props.workspace })}</DialogDescription>
    {props.permission.message ? <p className="whitespace-pre-wrap break-words">{props.permission.message}</p> : null}
    <div className="max-h-[40vh] overflow-y-auto rounded-lg border p-3">
      <p className="font-medium">{props.permission.action}</p>
      <ul className="mt-2 list-inside list-disc space-y-1 break-all text-muted-foreground">{props.permission.resources.map((resource, index) => <li key={`${index}:${resource}`}>{resource}</li>)}</ul>
    </div>
    {props.error ? <p role="alert" className="text-destructive">{props.error}</p> : null}
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={props.busy} onClick={() => props.onReply("reject")}>{t("legalmemory_permission.deny")}</Button>
      <Button disabled={props.busy} onClick={() => props.onReply("once")}>{t("legalmemory_permission.allow_once")}</Button>
    </div>
  </>;
}

/** Global human-interface approvals also work with no selected chat. Native
 * internal sessions remain private; only exact operation metadata is observed. */
export function LegalMemoryPermissions() {
  const activities = useSyncExternalStore(subscribeLegalMemoryInterfaceActivities, legalMemoryInterfaceActivities, legalMemoryInterfaceActivities);
  const queryClient = useQueryClient();
  useEffect(() => () => cancelLegalMemoryInterfaceReads(), []);
  const queries = useQueries({ queries: activities.map(activity => ({
    queryKey: ["legalmemory-interface-permissions", activity.id],
    queryFn: ({ signal }: { signal: AbortSignal }) => activity.permissions(signal),
    // Only active user-interface reads poll. This cadence is not an approval deadline.
    refetchInterval: 500, retry: false,
  })) });
  const pending = queries.flatMap((query, index) => { const data = query.data; return data ? data.requests.map(permission => ({ permission, workspace: data.workspace.name, activity: activities[index] })) : []; })[0];
  const failed = queries.map((query, index) => ({ query, activity: activities[index] })).find(item => item.query.error);
  const reply = useMutation({ mutationFn: async (input: { activity: LegalMemoryInterfaceActivity; permission: LegalMemoryPermission; decision: "once" | "reject" }) => {
    await input.activity.reply({ operationID: input.permission.operationID, requestID: input.permission.requestID, decision: input.decision });
  }, onSettled: (_data, _error, input) => queryClient.invalidateQueries({ queryKey: ["legalmemory-interface-permissions", input.activity.id] }) });
  const resetReply = reply.reset;
  useEffect(() => resetReply(), [pending?.permission.requestID, resetReply]);
  const replyTo = (decision: "once" | "reject") => { if (pending) reply.mutate({ ...pending, decision }); };
  if (pending) return <Dialog open onOpenChange={open => { if (!open && !reply.isPending) replyTo("reject"); }}><DialogContent showCloseButton={false}>
    <LegalMemoryPermissionNotice workspace={pending.workspace} permission={pending.permission} busy={reply.isPending} error={reply.error?.message} onReply={replyTo} />
  </DialogContent></Dialog>;
  if (failed) return <Dialog open onOpenChange={open => { if (!open) failed.activity.cancel(); }}><DialogContent>
    <DialogTitle>{t("legalmemory_permission.title")}</DialogTitle><DialogDescription>{t("legalmemory_permission.load_failed")}</DialogDescription>
    <p role="alert" className="whitespace-pre-wrap break-words">{failed.query.error?.message}</p>
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => failed.activity.cancel()}>{t("common.cancel")}</Button><Button onClick={() => void failed.query.refetch()}>{t("common.refresh")}</Button></div>
  </DialogContent></Dialog>;
  return null;
}
