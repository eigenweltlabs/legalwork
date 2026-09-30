/** @jsxImportSource react */
"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { UsageControlAction, UsageControlView, UsageRequestKind, MemberUsageView } from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Plus, RefreshCw, Users, Wallet } from "lucide-react";
import { MemberPlanChange } from "./member-actions";
import { CardTopUp, PaymentMethods } from "./payment-components";
import { usageCopy } from "./copy";

export type UsageTransport = { read: () => Promise<UsageControlView>; write: (action: UsageControlAction) => Promise<unknown>; open: (url: string) => void | Promise<void> };
export type Run = (action: UsageControlAction) => Promise<unknown>;
export type Text = (key: UsageTextKey) => string;
export type UsageTextKey = keyof typeof usageCopy.en;
const money = (cents: number) => new Intl.NumberFormat(undefined, {style:"currency", currency:"EUR"}).format(cents / 100);
function amount(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) throw new Error("amount");
  const result = Math.round(Number(raw.replace(",", ".")) * 100);
  if (!Number.isSafeInteger(result) || result < 0 || result > 5_000_000) throw new Error("amount");
  return result;
}
function requestKind(value: FormDataEntryValue | null): UsageRequestKind {
  if (value === "temporary" || value === "recurring" || value === "upgrade") return value;
  throw new Error("kind");
}
export function responseUrl(value: unknown) {
  if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string") throw new Error("response");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("checkout");
  return url.toString();
}
const fieldClass = "h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
export function UsageControlPanel({ transport, t, showHeading = true }: { transport: UsageTransport; t: (key: UsageTextKey) => string; showHeading?: boolean }) {
  const [view, setView] = useState<UsageControlView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [requestOpen, setRequestOpen] = useState(false);
  const refresh = useCallback(async () => { const next = await transport.read(); setView(next); }, [transport]);
  useEffect(() => {
    let active = true;
    const load = () => transport.read().then(value => { if (active) setView(value); }).catch(() => { if (active) setError(t("limits.load_error")); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [transport, t]);
  async function run(action: UsageControlAction) {
    setBusy(true); setError("");
    try {
      const result = await transport.write(action);
      if (action.action === "checkout" || action.action === "paymentSetup") await transport.open(responseUrl(result));
      else { await refresh(); setRequestOpen(false); }
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setError(detail.includes("purchase_seat_first") ? t("limits.buy_seat_first")
        : detail.includes("request_expired") ? t("limits.request_expired") : t("limits.action_error"));
      throw err;
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, build: (form: FormData) => UsageControlAction) {
    event.preventDefault();
    try { void run(build(new FormData(event.currentTarget))).catch(() => {}); }
    catch { setError(t("limits.invalid_amount")); }
  }
  const call = (action: UsageControlAction) => { void run(action).catch(() => {}); };
  return <div className="min-w-0 space-y-5" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-3">{showHeading && <h2 className="text-lg font-semibold tracking-tight">{t("limits.title")}</h2>}
      <Button variant="ghost" size="sm" className="ml-auto" disabled={busy} onClick={() => void refresh().catch(() => setError(t("limits.load_error")))}><RefreshCw className="size-4" />{t("limits.refresh")}</Button></div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {!view ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("limits.loading")}</p> : !view.enabled ? <p className="rounded-lg border p-3 text-sm text-muted-foreground">{t("limits.not_enabled")}</p> : <>
      <Card className="gap-0 space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm text-muted-foreground">{t("limits.your_usage")}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(view.me.remainingCents)} <span className="text-sm font-normal text-muted-foreground">{t("limits.remaining")}</span></p></div><span className="rounded-lg border px-3 py-1 text-sm capitalize">{view.me.plan === "none" ? t("limits.no_seat") : view.me.plan}</span></div>
        <div role="progressbar" aria-label={t("limits.your_usage")} aria-valuemin={0} aria-valuemax={view.me.allowanceCents} aria-valuenow={view.me.allowanceCents - view.me.remainingCents} className="h-2 w-full overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground" style={{width:`${Math.min(100,100 * (view.me.allowanceCents - view.me.remainingCents) / Math.max(1,view.me.allowanceCents))}%`}} /></div>
        <p className="text-xs text-muted-foreground">{t("limits.resets")} {new Date(view.me.resetsAt).toLocaleString()}</p>
        <p className="text-sm">{t("limits.extra")}: <span className="tabular-nums">{money(view.me.extraUsedCents)} / {money(view.me.extraLimitCents)}</span> · {t("limits.resets")} {new Date(view.me.extraResetsAt).toLocaleDateString()}</p>
        {view.me.blockedReason && <p role="status" className="text-sm font-medium">{t("limits.blocked")}</p>}
        <Dialog open={requestOpen} onOpenChange={setRequestOpen}><DialogTrigger render={<Button disabled={busy || view.requests.some(r => r.userId === view.me.userId && r.status === "pending")} />}><Plus className="size-4" />{t("limits.request")}</DialogTrigger>
          <DialogContent><DialogHeader><DialogTitle>{t("limits.request")}</DialogTitle><DialogDescription>{t("limits.request_hint")}</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={event => submit(event, form => ({action:"request", kind: requestKind(form.get("kind")), amountCents: String(form.get("kind")) === "upgrade" ? 0 : amount(form.get("amount")), reason:String(form.get("reason") ?? "")}))}>
              <label className="grid gap-2 text-sm">{t("limits.kind")}<select name="kind" className={fieldClass}><option value="temporary">{t("limits.temporary")}</option><option value="recurring">{t("limits.recurring")}</option><option value="upgrade">{t("limits.upgrade")}</option></select></label>
              <label className="grid gap-2 text-sm">{t("limits.amount")}<Input name="amount" inputMode="decimal" defaultValue="30" /></label>
              <label className="grid gap-2 text-sm">{t("limits.reason")}<Input name="reason" maxLength={1000} /></label>
              <Button type="submit" disabled={busy}>{t("limits.send")}</Button>
            </form></DialogContent></Dialog>
      </Card>
      <Card className="gap-0 space-y-4 p-5"><h3 className="font-medium">{t("limits.requests")}</h3>
        {view.requests.length === 0 ? <p className="text-sm text-muted-foreground">{t("limits.no_requests")}</p> : view.requests.map(request => <div key={request.id} className="space-y-2 border-t pt-4 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><strong>{request.name}</strong><span>{t(request.status === "pending" ? "limits.pending" : request.status === "approved" ? "limits.approved" : "limits.declined")}</span></div>
          <p>{t(request.kind === "temporary" ? "limits.temporary" : request.kind === "recurring" ? "limits.recurring" : "limits.upgrade")} {request.kind !== "upgrade" && money(request.approvedCents ?? request.amountCents)} · {request.month}</p>
          {request.reason && <p className="break-words text-muted-foreground">{request.reason}</p>}{request.decisionNote && <p className="break-words">{request.decisionNote}</p>}
          {view.isAdmin && request.status === "pending" && request.kind !== "upgrade" && <form className="flex flex-wrap items-end gap-2" onSubmit={event => submit(event, form => ({action:"decide", requestId:request.id, approve:true, amountCents:amount(form.get("amount")), note:String(form.get("note") ?? "")}))}>
            <label className="grid gap-1">{t("limits.amount")}<Input name="amount" className="w-28" inputMode="decimal" defaultValue={request.amountCents / 100} /></label>
            <label className="grid min-w-0 flex-1 gap-1">{t("limits.note")}<Input name="note" maxLength={1000} /></label>
            <Button type="submit" disabled={busy}>{t("limits.approve")}</Button><Button type="button" variant="outline" disabled={busy} onClick={event => {const form = event.currentTarget.form; call({action:"decide", requestId:request.id, approve:false, amountCents:0, note:form ? String(new FormData(form).get("note") ?? "") : ""});}}>{t("limits.decline")}</Button>
          </form>}
          {view.isAdmin && request.status === "pending" && request.kind === "upgrade" && <div className="space-y-2"><MemberPlanChange target={{kind:"plan",userId:request.userId,plan:"pro",requestId:request.id,note:""}} transport={transport} refresh={refresh} t={t}/><Button variant="outline" disabled={busy} onClick={()=>call({action:"decide",requestId:request.id,approve:false,amountCents:0,note:""})}>{t("limits.decline")}</Button></div>}
          {request.status === "approved" && request.userId === view.me.userId && view.me.blockedReason && <p className="text-muted-foreground">{t("limits.awaiting_funds")}</p>}
        </div>)}
      </Card>
      {view.isAdmin && <>
        <Card className="gap-0 space-y-4 p-5"><h3 className="flex items-center gap-2 font-medium"><Wallet className="size-4" />{t("limits.wallet")}</h3><p className="text-2xl font-semibold tabular-nums">{money(view.walletCents ?? 0)}</p><p className="text-sm text-muted-foreground">{t("limits.wallet_hint")}</p>
          <CardTopUp transport={transport} t={t} run={run} busy={busy}/>
          <form className="grid gap-3 border-t pt-4 sm:grid-cols-2" onSubmit={event => submit(event, form => ({action:"settings", enabled:form.get("enabled") === "on", monthlyLimitCents:String(form.get("monthly") ?? "").trim() === "" ? null : amount(form.get("monthly")), defaultLimitCents:amount(form.get("default"))}))}>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input name="enabled" type="checkbox" defaultChecked={view.extraEnabled} />{t("limits.enable_extra")}</label>
            <label className="grid gap-2 text-sm">{t("limits.org_limit")}<Input name="monthly" inputMode="decimal" defaultValue={view.orgExtraLimitCents === null ? "" : view.orgExtraLimitCents / 100} /></label>
            <label className="grid gap-2 text-sm">{t("limits.default_limit")}<Input name="default" inputMode="decimal" defaultValue={view.defaultExtraLimitCents / 100} /></label>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t("limits.month_used")} {money(view.orgExtraUsedCents ?? 0)} · {t("limits.unlimited_hint")}</p><Button type="submit" disabled={busy}>{t("limits.save")}</Button>
          </form>
        </Card>
        <PaymentMethods refreshSignal={view} transport={transport} t={t} run={run} busy={busy}/>
        <Card className="gap-0 space-y-4 p-5"><h3 className="flex items-center gap-2 font-medium"><Users className="size-4" />{t("limits.members")}</h3><p className="text-sm text-muted-foreground">Sync: {view.seats.sync ?? 0} · Plus: {view.seats.plus} · Pro: {view.seats.pro}</p>
          {view.pendingMemberChanges?.map(op=><div key={op.quoteId} className="space-y-2 rounded-lg border p-3 text-sm"><p>{t("limits.pending_change_hint")}</p><Button variant="outline" disabled={busy} onClick={()=>call({action:"memberChange",target:op.target,preview:false,quoteId:op.quoteId,expectedAmountCents:op.amountCents})}>{t("limits.retry_change")}</Button></div>)}
          {view.invitations?.map(invite=><div key={invite.id} className="space-y-1 border-t pt-3 text-sm"><p className="break-all">{invite.email}</p><p className="text-muted-foreground">{t("limits.invitation_pending")} · {invite.plan}</p></div>)}
          {view.members.map(member => <MemberEditor key={member.userId} member={member} busy={busy} t={t} submit={submit} call={call} transport={transport} refresh={refresh} />)}
          <div className="space-y-3 border-t pt-4"><h4 className="text-sm font-medium">{t("limits.invite_member")}</h4><p className="text-xs text-muted-foreground">{t("limits.invite_hint")}</p><MemberPlanChange transport={transport} refresh={refresh} t={t} invite /></div>
        </Card>
      </>}
    </>}
  </div>;
}
function MemberEditor({ member, busy, t, submit, call, transport, refresh }: {transport:UsageTransport;refresh:()=>Promise<void>;member:MemberUsageView; busy:boolean; t:(key:UsageTextKey)=>string; submit:(event:FormEvent<HTMLFormElement>,build:(form:FormData)=>UsageControlAction)=>void; call:(action:UsageControlAction)=>void}) {
  return <div className="space-y-3 border-t pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{member.name}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div>
    <MemberPlanChange target={{kind:"plan",userId:member.userId,plan:member.plan}} transport={transport} refresh={refresh} t={t}/></div>
    <p className="text-xs text-muted-foreground">{t("limits.remaining")}: {money(member.remainingCents)} · {t("limits.extra")}: {money(member.extraUsedCents)} / {money(member.extraLimitCents)}</p>
    <form className="flex flex-wrap items-end gap-2" onSubmit={e => submit(e, form => ({action:"budget",userId:member.userId,limitCents:amount(form.get("limit"))}))}><label className="grid gap-1 text-sm">{t("limits.member_limit")}<Input name="limit" key={`${member.baseExtraLimitCents}`} inputMode="decimal" defaultValue={member.baseExtraLimitCents / 100} className="w-32" /></label><Button type="submit" variant="outline" disabled={busy}>{t("limits.save")}</Button><Button type="button" variant="ghost" disabled={busy || member.inheritsLimit} onClick={() => call({action:"budget",userId:member.userId,limitCents:null})}>{t("limits.inherit")}</Button></form>
  </div>;
}
