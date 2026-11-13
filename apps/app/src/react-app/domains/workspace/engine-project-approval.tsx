import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type EngineProjectStatus } from "@legalwork/types/engine-project";
import { Button } from "@/components/ui/button";
import { type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function engineProjectStatusQueryKey(client: LegalworkServerClient, workspaceId: string) {
  return ["engine-project-status", client.baseUrl, workspaceId];
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
  if (props.status.projection.diagnostic) return <section role="alert" className="shrink-0 border-b border-border px-5 py-3 text-sm">
    <p>{props.status.projection.diagnostic}</p>
    {props.error ? <p className="mt-2 text-destructive">{props.error}</p> : null}
    <Button className="mt-2" size="sm" variant="outline" disabled={props.pending} onClick={props.onRetry}>{t(props.pending ? "engine_project.recovery_retrying" : "common.refresh")}</Button>
  </section>;
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

export function EngineProjectRecovery(props: { client: LegalworkServerClient; workspaceId: string }) {
  const queryClient = useQueryClient();
  const queryKey = engineProjectStatusQueryKey(props.client, props.workspaceId);
  const status = useQuery({ queryKey, queryFn: () => props.client.getEngineProjectStatus(props.workspaceId), retry: false,
    refetchInterval: query => engineProjectRecoveryRefetchInterval(query.state.data),
  });
  const recovery = useMutation({
    mutationFn: () => props.client.retryEngineRecovery(props.workspaceId),
    onSuccess: next => { queryClient.setQueryData(queryKey, next); },
  });
  if (!status.data) {
    if (!status.error) return null;
    return <div role="alert" className="shrink-0 border-b border-border px-5 py-3 text-sm">{t("engine_project.load_failed")} <Button size="sm" variant="outline" onClick={() => void status.refetch()}>{t("common.refresh")}</Button></div>;
  }
  return <EngineProjectRecoveryNotice status={status.data} pending={recovery.isPending}
    error={recovery.error ? t("engine_project.recovery_retry_failed") : undefined}
    onRetry={() => recovery.mutate()} />;
}
