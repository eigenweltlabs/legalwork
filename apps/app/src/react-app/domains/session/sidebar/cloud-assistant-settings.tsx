import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cloud, CloudOff, Loader2, RefreshCw } from "lucide-react";
import type { CloudAssistantStatus } from "@legalwork/types/cloud-assistant";
import { DEFAULT_ASSISTANT_PROFILE, type AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { AssistantAvatar } from "./assistant-appearance";

type CloudClient = Pick<LegalworkServerClient, "baseUrl" | "cloudAssistantStatus" | "enableCloudAssistant" | "disableCloudAssistant">;
function settingUp(status: CloudAssistantStatus | undefined) {
  return Boolean(status && ["preparing", "syncing", "starting"].includes(status.state));
}

export function CloudAssistantSettings({ client, profile = DEFAULT_ASSISTANT_PROFILE, onSignIn }: {
  client: CloudClient; profile?: AssistantProfile; onSignIn: () => void;
}) {
  const cache = useQueryClient();
  const key = ["cloud-assistant", client.baseUrl];
  const [open, setOpen] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const change = useMutation({
    mutationKey: key,
    mutationFn: (enabled: boolean) => enabled ? client.enableCloudAssistant() : client.disableCloudAssistant(),
    onMutate: async () => { await cache.cancelQueries({ queryKey: key }); },
    onSuccess: (next, enabled) => { cache.setQueryData(key, next); if (!enabled) setOpen(false); },
    onSettled: () => { void cache.invalidateQueries({ queryKey: key }); },
  });
  const query = useQuery({
    queryKey: key, queryFn: () => client.cloudAssistantStatus(), retry: 1,
    refetchOnMount: "always", refetchOnWindowFocus: true,
    refetchInterval: state => settingUp(state.state.data) || change.isPending ? 2000 : 15000,
  });
  const status = query.data;
  const ready = Boolean(status?.enabled && status.state === "enabled");
  const preparing = !ready && (settingUp(status) || (change.isPending && change.variables === true));
  const error = change.isPending ? null : change.error?.message ?? status?.error;
  useEffect(() => {
    // A failed request can have started setup successfully. Trust a later
    // status read instead of leaving the modal stuck on the transport error.
    if (change.isError && change.variables === true && (ready || settingUp(status))) change.reset();
  }, [change.isError, change.variables, query.dataUpdatedAt, ready, status, change.reset]);
  const start = () => {
    if (change.isPending || settingUp(status)) return;
    setStartedAt(Date.now()); setElapsed(0);
    change.mutate(true);
  };
  const showSetup = () => {
    setOpen(true); change.reset();
    if (status?.connected && !ready && !settingUp(status)) start();
  };
  useEffect(() => {
    if (!open || !preparing) return;
    const start = startedAt ?? Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [open, preparing, startedAt]);

  return <>
    <div className="space-y-3 border-t border-border py-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40"><Cloud className="size-4 text-muted-foreground" /></span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{t("assistant.cloud_title")}</h3>
            {ready && <span className="inline-flex items-center gap-1 rounded-full bg-green-3 px-2 py-0.5 text-[11px] text-green-11"><Check className="size-3" />{t("assistant.cloud_active")}</span>}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("assistant.cloud_hint")}</p>
        </div>
      </div>
      <Button type="button" variant={ready ? "outline" : "default"} size="sm" className="w-fit" disabled={query.isPending || change.isPending} onClick={showSetup}>
        {preparing ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Cloud className="size-4" />}
        {t(query.isPending ? "assistant.cloud_checking" : ready ? "assistant.cloud_manage" : preparing ? "assistant.cloud_view_setup" : "assistant.cloud_enable")}
      </Button>
      {ready && <p className="text-xs leading-relaxed text-muted-foreground">{t("assistant.cloud_ready", { account: status?.accountName ?? "Eigenwelt" })}</p>}
      {ready && status?.sync && (status.sync.running || status.sync.pendingProjects > 0) && <p className="text-xs text-muted-foreground">{t("assistant.cloud_background", { count: status.sync.pendingProjects })}</p>}
      {(query.isError || error || status?.sync?.error) && <p role="alert" className="text-xs text-destructive">{query.isError ? t("assistant.cloud_status_error") : error ?? status?.sync?.error}</p>}
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[460px]">
        <div className="space-y-5 px-6 pb-6 pt-10">
          <CloudAssistantProgress profile={profile} status={status} preparing={preparing} error={Boolean(error)} />
          <div className="space-y-2 text-center" aria-live="polite">
            <DialogTitle>{t(error ? "assistant.cloud_setup_failed" : ready ? "assistant.cloud_setup_ready" : !status?.connected ? "assistant.cloud_connect_title" : "assistant.cloud_setup_title")}</DialogTitle>
            <DialogDescription>{t(error ? "assistant.cloud_setup_retry_hint" : ready ? "assistant.cloud_ready" : !status?.connected ? "assistant.cloud_sign_in" : status?.state === "starting" ? "assistant.cloud_starting" : status?.state === "syncing" ? "assistant.cloud_syncing" : "assistant.cloud_preparing", { account: status?.accountName ?? "Eigenwelt" })}</DialogDescription>
          </div>
          {status?.connected && <CloudAssistantSteps status={status} preparing={preparing} error={Boolean(error)} />}
          {preparing && elapsed >= 45 && <p role="status" className="rounded-xl bg-muted/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("assistant.cloud_taking_longer")}</p>}
          {(error || query.isError) && <div role="alert" className="space-y-2 rounded-xl border border-red-6 bg-red-2 px-4 py-3 text-xs leading-relaxed text-red-11">
            <p>{query.isError ? t("assistant.cloud_status_error") : error}</p>
            <Button type="button" variant="ghost" size="sm" disabled={query.isFetching} onClick={() => { change.reset(); void query.refetch(); }}><RefreshCw className="size-3.5" />{t("assistant.cloud_check_status")}</Button>
          </div>}
          {ready && status?.sync && (status.sync.running || status.sync.pendingProjects > 0) && <p className="text-xs leading-relaxed text-muted-foreground">{t("assistant.cloud_background", { count: status.sync.pendingProjects })}</p>}
          {ready && status?.sync?.error && <p role="alert" className="text-xs text-destructive">{status.sync.error}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/20 px-6 py-4">
          {ready && <Button type="button" variant="ghost" disabled={change.isPending} onClick={() => change.mutate(false)}>{t(change.isPending ? "assistant.cloud_disabling" : "assistant.cloud_disable")}</Button>}
          {error && !preparing && !ready && status?.connected && !query.isError && <Button type="button" disabled={change.isPending} onClick={start}>{t("assistant.cloud_retry")}</Button>}
          <Button type="button" variant={preparing || error || !status?.connected ? "outline" : "default"} onClick={() => setOpen(false)}>{t(preparing ? "assistant.cloud_continue_background" : ready ? "assistant.cloud_done" : "common.close")}</Button>
          {!status?.connected && !query.isError && <Button type="button" onClick={() => { setOpen(false); onSignIn(); }}>{t("account.sign_in")}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function CloudAssistantProgress({ profile, status, preparing, error }: { profile: AssistantProfile; status?: CloudAssistantStatus; preparing: boolean; error: boolean }) {
  const ready = status?.enabled && !error;
  return <div className="relative mx-auto flex size-36 items-center justify-center" aria-hidden="true">
    <span className={cn("absolute inset-4 rounded-full blur-xl", ready ? "bg-green-4/70" : "bg-blue-4/70", preparing && "motion-safe:animate-pulse")} />
    <span className="absolute inset-1 rounded-full border border-border/60" />
    {preparing && <svg viewBox="0 0 144 144" className="absolute inset-0 size-full text-blue-9 motion-safe:animate-spin [animation-duration:6s]"><circle cx="72" cy="72" r="67" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="48 373" strokeLinecap="round" /></svg>}
    <span className="relative flex size-24 items-center justify-center rounded-full border border-border/70 bg-background/80 shadow-sm"><AssistantAvatar icon={profile.icon} motion={preparing ? "thinking" : "idle"} className="size-16" /></span>
    <span className={cn("absolute bottom-3 right-3 flex size-8 items-center justify-center rounded-full border-4 border-background", error ? "bg-red-3 text-red-11" : ready ? "bg-green-3 text-green-11" : "bg-blue-3 text-blue-11")}>{error ? <CloudOff className="size-4" /> : ready ? <Check className="size-4" /> : <Cloud className="size-4" />}</span>
  </div>;
}

export function CloudAssistantSteps({ status, preparing, error }: { status?: CloudAssistantStatus; preparing: boolean; error: boolean }) {
  const active = status?.enabled ? 3 : status?.state === "starting" ? 1 : 0;
  const labels = ["assistant.cloud_step_prepare", "assistant.cloud_step_start", "assistant.cloud_step_ready"];
  return <ol aria-label={t("assistant.cloud_setup_progress")} className="space-y-3">
    {labels.map((label, index) => <li key={label} aria-current={!error && preparing && index === active ? "step" : undefined} className={cn("flex items-center gap-3 text-sm", index > active && "text-muted-foreground")}>
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs", index < active ? "bg-green-3 text-green-11" : index === active && !error ? "bg-blue-3 text-blue-11" : "bg-muted text-muted-foreground")}>
        {index < active ? <Check className="size-3.5" /> : index === active && preparing && !error ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : index + 1}
      </span>{t(label)}{index < active && <span className="sr-only">{t("assistant.cloud_done")}</span>}
    </li>)}
  </ol>;
}
