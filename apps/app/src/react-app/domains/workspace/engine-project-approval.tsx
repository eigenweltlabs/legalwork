import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EngineProjectStatusSchema, type EngineProjectStatus } from "@legalwork/types/engine-project";
import { Button } from "@/components/ui/button";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import { t } from "@/i18n";

export function engineProjectStatusQueryKey(client: LegalworkServerClient, workspaceId: string) {
  return ["engine-project-status", client.baseUrl, workspaceId];
}

export function changedEngineProjectStatus(error: unknown) {
  if (!(error instanceof LegalworkServerError) || error.status !== 409) return;
  if (!["project_plugin_approval_changed", "project_automation_approval_required"].includes(error.code)) return;
  const result = EngineProjectStatusSchema.safeParse(error.details);
  return result.success ? result.data : undefined;
}

/** Submit only the exact scope displayed to the person who clicked approval. */
export function approveReviewedEngineProject(client: LegalworkServerClient, workspaceId: string, status: EngineProjectStatus) {
  return client.approveEngineProject(workspaceId, status.directory, status.plugins.filter(plugin => !plugin.approved).map(plugin => plugin.target));
}

export function engineProjectRecoveryRefetchInterval(status: EngineProjectStatus | undefined) {
  return status?.recovery && status.recovery.mode !== "service" ? 1500 : false;
}

export function EngineProjectRecoveryNotice(props: {
  status: EngineProjectStatus;
  pending?: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const recovery = props.status.recovery;
  if (!recovery || recovery.mode === "service") return null;
  const promoting = recovery.mode === "promoting";
  return <section role="status" aria-label={t("engine_project.recovery_title")} className="shrink-0 border-b border-border bg-muted/40 px-5 py-3 text-sm">
    <h2 className="font-medium">{t("engine_project.recovery_title")}</h2>
    <p className="mt-1 text-muted-foreground">{t(promoting ? "engine_project.recovery_promoting" : recovery.heldSessionIds.length > 0 ? "engine_project.recovery_paused" : recovery.waitingForOtherProjects ? "engine_project.recovery_waiting" : "engine_project.recovery_checking")}</p>
    {!promoting && recovery.heldSessionIds.length > 0 && recovery.waitingForOtherProjects ? <p className="mt-1 text-muted-foreground">{t("engine_project.recovery_waiting")}</p> : null}
    {recovery.error ? <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-destructive">{recovery.error.message}</p> : null}
    {props.error ? <p role="alert" className="mt-2 text-destructive">{props.error}</p> : null}
    {!promoting ? <Button className="mt-2" size="sm" variant="outline" disabled={props.pending} onClick={props.onRetry}>{t(props.pending ? "engine_project.recovery_retrying" : "engine_project.recovery_retry")}</Button> : null}
  </section>;
}

export function EngineProjectApprovalNotice(props: {
  status: EngineProjectStatus;
  pending?: boolean;
  error?: string;
  onApprove: () => void;
  onRefresh: () => void;
}) {
  const { status } = props;
  if (!status.required || status.state === "ready") return null;
  const conflict = status.state === "configuration_conflict";
  const plugins = status.plugins.filter(plugin => !plugin.approved);
  return <section role="region" aria-label={t("engine_project.title")} className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border bg-muted/40 px-5 py-4 text-sm">
    <h2 className="font-medium">{t(conflict ? "engine_project.conflict" : "engine_project.title")}</h2>
    {conflict ? <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{status.projection.diagnostic ?? t("engine_project.conflict_detail")}</p> : <>
      <p className="mt-1 text-muted-foreground">{t("engine_project.explanation")}</p>
      <details className="mt-2" open>
        <summary className="cursor-pointer font-medium">{t("engine_project.locations")}</summary>
        <ul className="mt-1 list-inside list-disc space-y-1 break-all text-muted-foreground">
          <li>{status.directory}</li>
          {status.approvalScope.map(scope => <li key={scope.directory}>{scope.directory}
            {scope.configPaths.length > 0 ? <ul className="ml-5 list-inside list-disc">{scope.configPaths.map(path => <li key={path}>{path}</li>)}</ul> : null}
          </li>)}
        </ul>
      </details>
      {plugins.length > 0 ? <div className="mt-2">
        <h3 className="font-medium">{t("engine_project.plugins")}</h3>
        <ul className="mt-1 list-inside list-disc space-y-1 break-all text-muted-foreground">{plugins.map(plugin => <li key={plugin.target}>{plugin.target}<ul className="ml-5 list-inside list-disc">{plugin.sources.map(source => <li key={source}>{source}</li>)}</ul></li>)}</ul>
        <p className="mt-1 text-muted-foreground">{t("engine_project.plugin_updates")}</p>
      </div> : null}
    </>}
    {props.error ? <p role="alert" className="mt-2 text-destructive">{props.error}</p> : null}
    <div className="mt-3 flex gap-2">
      {!conflict ? <Button size="sm" disabled={props.pending} onClick={props.onApprove}>{t(props.pending ? "engine_project.approving" : "engine_project.approve")}</Button> : null}
      <Button size="sm" variant="outline" disabled={props.pending} onClick={props.onRefresh}>{t("common.refresh")}</Button>
    </div>
  </section>;
}

export function EngineProjectApproval(props: { client: LegalworkServerClient; workspaceId: string; onApproved?: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = engineProjectStatusQueryKey(props.client, props.workspaceId);
  const status = useQuery({ queryKey, queryFn: () => props.client.getEngineProjectStatus(props.workspaceId), retry: false,
    refetchInterval: query => engineProjectRecoveryRefetchInterval(query.state.data),
  });
  const recovery = useMutation({
    mutationFn: () => props.client.retryEngineRecovery(props.workspaceId),
    onSuccess: next => { queryClient.setQueryData(queryKey, next); },
  });
  const approve = useMutation({
    mutationFn: (reviewed: EngineProjectStatus) => approveReviewedEngineProject(props.client, props.workspaceId, reviewed),
    onSuccess: async next => {
      queryClient.setQueryData(queryKey, next);
      await refreshProviderListQueries(queryClient);
      props.onApproved?.();
    },
    onError: error => {
      const changed = changedEngineProjectStatus(error);
      // New executable declarations require a fresh click after review.
      if (changed) queryClient.setQueryData(queryKey, changed);
    },
  });
  if (!status.data) {
    if (!status.error) return null;
    return <div role="alert" className="shrink-0 border-b border-border px-5 py-3 text-sm">{t("engine_project.load_failed")} <Button size="sm" variant="outline" onClick={() => void status.refetch()}>{t("common.refresh")}</Button></div>;
  }
  const current = status.data;
  const changed = changedEngineProjectStatus(approve.error);
  const error = approve.error ? changed ? t("engine_project.changed") : approve.error.message : undefined;
  return <>
    <EngineProjectRecoveryNotice status={current} pending={recovery.isPending} error={recovery.error ? t("engine_project.recovery_retry_failed") : undefined} onRetry={() => recovery.mutate()} />
    <EngineProjectApprovalNotice status={current} pending={approve.isPending} error={error} onApprove={() => approve.mutate(current)} onRefresh={() => { approve.reset(); void status.refetch(); }} />
  </>;
}
