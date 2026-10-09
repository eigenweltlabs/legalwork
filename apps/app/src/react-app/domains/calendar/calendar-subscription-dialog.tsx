import { useEffect, useState } from "react";
import { CalendarDays, Check, Copy, Link2, Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { calendarError } from "./calendar-format";

export function CalendarSubscriptionDialog({ client, workspaceId, projectName, hasRemoteProjects, onClose }: {
  client: LegalworkServerClient; workspaceId: string | null; projectName?: string; hasRemoteProjects: boolean; onClose: () => void;
}) {
  const [subscription, setSubscription] = useState<Awaited<ReturnType<LegalworkServerClient["calendarSubscription"]>> | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false), [confirmDisable, setConfirmDisable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void client.calendarSubscription(workspaceId).then(value => { if (!cancelled) setSubscription(value); })
      .catch(error => { if (!cancelled) setError(calendarError(error)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [client, workspaceId]);
  const change = async (method: string) => {
    setBusy(true); setError(null); setCopied(false);
    try { setSubscription(await client.calendarSubscription(workspaceId, method)); }
    catch (error) { setError(calendarError(error)); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!subscription?.url) return;
    try { await navigator.clipboard.writeText(subscription.url); setCopied(true); }
    catch { setError(t("calendar.subscription_copy_failed")); }
  };
  return <>
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="grid-cols-1 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("calendar.subscribe")}</DialogTitle>
          <DialogDescription>{t("calendar.subscription_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 p-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50"><CalendarDays className="size-4 text-muted-foreground" /></div>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{workspaceId ? projectName || t("calendar.title") : t("calendar.all_projects_short")}</p><p className="mt-0.5 text-xs text-muted-foreground">{t(workspaceId ? "calendar.subscription_project" : "calendar.subscription_all")}</p></div>
          </div>
          {busy && !subscription ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("calendar.loading")}</p> : null}
          {subscription?.url ? <div className="space-y-2">
            <Label htmlFor="calendar-subscription-url">{t("calendar.subscription_url")}</Label>
            <div className="flex gap-2"><Input id="calendar-subscription-url" readOnly value={subscription.url} onFocus={event => event.currentTarget.select()} className="min-w-0 text-xs" /><Button variant="outline" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{t(copied ? "calendar.subscription_copied" : "calendar.subscription_copy")}</Button></div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("calendar.subscription_private_link")}</p>
          </div> : subscription?.available ? <p className="text-sm leading-relaxed text-muted-foreground">{t("calendar.subscription_sync_hint")}</p> : null}
          {subscription && !subscription.available && <p className="text-sm leading-relaxed text-muted-foreground">{t("calendar.subscription_required")}</p>}
          {subscription?.url && <p className="text-xs leading-relaxed text-muted-foreground">{t("calendar.subscription_refresh_hint")}</p>}
          {hasRemoteProjects && <p className="text-xs leading-relaxed text-muted-foreground">{t("calendar.subscription_remote_hint")}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          {subscription?.url && <Button variant="ghost" className="text-destructive sm:mr-auto" disabled={busy} onClick={() => setConfirmDisable(true)}>{t("calendar.subscription_disable")}</Button>}
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.close")}</Button>
          {error && <Button variant="outline" disabled={busy} onClick={() => void change("GET")}>{t("workspace_files.try_again")}</Button>}
          {!subscription?.url && subscription?.available && <Button disabled={busy} onClick={() => void change("POST")}>{busy ? <Loader2 className="animate-spin" /> : <Link2 />}{t("calendar.subscription_create")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmDisable} onOpenChange={setConfirmDisable}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("calendar.subscription_disable_title")}</AlertDialogTitle><AlertDialogDescription>{t("calendar.subscription_disable_description")}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { setConfirmDisable(false); void change("DELETE"); }}>{t("calendar.subscription_disable")}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
