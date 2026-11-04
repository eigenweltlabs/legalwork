import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { ChevronDown, ChevronUp, FileText, Loader2, Mail, Paperclip, X } from "lucide-react";
import { epostDraft, emptyEpostAddress, type EpostDraft, type EpostQuote, type EpostReceipt } from "@legalwork/types/epost";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useOpenTargets } from "@/lib/target-provider";
import { resolvePathOpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { ProjectFilePicker } from "@/react-app/domains/calendar/deadline-links";
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store";
import { InlineCard, InlineCardFooter, InlineCardHeader } from "./inline-card";
import { useMessageList } from "./message-list-provider";
import { draftToolPayload } from "./connector-draft-actions";

const settingsKey = (client: LegalworkServerClient | null | undefined) => ["epost-settings", client?.baseUrl];
export function useEpostSettings(client: LegalworkServerClient | null | undefined, visible = true) {
  return useQuery({
    queryKey: settingsKey(client), enabled: Boolean(client && visible), staleTime: 30_000, retry: false,
    queryFn: () => {
      if (!client) throw new Error(t("epost.unavailable"));
      return client.epostSettings();
    },
  });
}

export function EpostIntegration({ client }: { client?: LegalworkServerClient | null }) {
  const settings = useEpostSettings(client);
  const query = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!client || !settings.data?.available) return null;
  return <div className="rounded-xl border p-4">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3"><Mail className="size-4" /><div>
        <div className="text-sm font-medium">{t("epost.title")}</div>
        <p className="text-xs text-muted-foreground">{t("epost.settings_description")}</p>
      </div></div>
      <Switch aria-label={t("epost.title")} checked={settings.data.enabled} disabled={busy} onCheckedChange={async value => {
        setBusy(true); setError("");
        try { query.setQueryData(settingsKey(client), await client.setEpostEnabled(value)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : t("epost.unavailable")); }
        finally { setBusy(false); }
      }} />
    </div>
    {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
  </div>;
}

export function isEpostDraftTool(part: ToolUIPart | DynamicToolUIPart) {
  return getToolName(part) === "legalwork_epost_draft";
}

export function EpostDraftToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const { legalworkClient, workspaceId, sessionId } = useMessageList();
  if (part.state !== "output-available" && part.state !== "output-error") return <p role="status">{t("epost.preparing")}</p>;
  let payload: unknown;
  try { payload = part.state === "output-available" ? draftToolPayload(part.output) : null; }
  catch { payload = null; }
  const result = epostDraft.safeParse(payload && typeof payload === "object" && "draft" in payload ? payload.draft : null);
  if (!result.success || !legalworkClient || workspaceId !== result.data.workspaceId)
    return <p className="text-sm text-muted-foreground" role="status">{t("epost.draft_unavailable")}</p>;
  return <EpostDraftCard key={result.data.id} initial={result.data} client={legalworkClient} panelScope={sessionId} />;
}

const addressKeys = ["name", "street", "postalCode", "city"] as const;
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(cents / 100);
const fileName = (path: string) => path.split("/").at(-1) ?? path;
const registeredOptions = ["none", "dropoff", "signature", "receipt"] as const;

export function EpostDraftCard({ initial, client, panelScope, onClose }: {
  initial: EpostDraft; client: LegalworkServerClient; panelScope: string; onClose?: () => void;
}) {
  const { openTargets, onOpenTarget } = useOpenTargets();
  const [draft, setDraft] = useState(initial);
  const [pickingFiles, setPickingFiles] = useState(false);
  const [quote, setQuote] = useState<EpostQuote | null>(null);
  const query = useQueryClient();
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const id = useId();
  const settings = useEpostSettings(client);
  const receiptKey = ["epost-receipt", client.baseUrl, draft.workspaceId, draft.id];
  const previous = useQuery({
    queryKey: receiptKey, enabled: settings.data?.enabled === true, retry: false,
    refetchInterval: state => {
      const receipt = state.state.data;
      if (receipt?.state === "pending" || receipt?.state === "accepted" ||
        (receipt?.mode === "live" && receipt.state === "processed")) return receipt.mode === "sandbox" ? 20_000 : 60_000;
      return false;
    },
    queryFn: async () => {
      try { return await client.epostReceipt(draft.workspaceId, draft.id); }
      catch (cause) { if (cause instanceof LegalworkServerError && cause.status === 404) return null; throw cause; }
    },
  });
  const final = previous.data;
  const mode = final?.mode ?? settings.data?.mode;
  const locked = Boolean(final || busy || quote || uncertain || previous.isLoading || !settings.data?.enabled);
  const sender = draft.sender ?? emptyEpostAddress;
  const recipient = draft.recipient ?? emptyEpostAddress;
  const ready = draft.files.length > 0 && addressKeys.every(key => sender[key].trim() && recipient[key].trim()) &&
    /^\d{5}$/.test(sender.postalCode.trim()) && (Boolean(draft.recipient?.country?.trim()) || /^\d{5}$/.test(recipient.postalCode.trim()));
  const country = draft.recipient?.country ?? "";
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("epost.unavailable")); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const review = () => run(async () => {
    setQuote(await client.epostReview(draft.workspaceId, { ...draft, recipient: { ...recipient, country: country.trim() || undefined } }));
  });
  const submit = () => run(async () => {
    if (!quote || !settings.data?.enabled) return;
    try { query.setQueryData<EpostReceipt>(receiptKey, await client.epostSubmit(draft.workspaceId, quote.reviewId)); }
    catch (cause) {
      if (!(cause instanceof LegalworkServerError) || cause.status >= 500) setUncertain(true);
      throw cause;
    } finally { setQuote(null); }
  });
  const refresh = () => run(async () => {
    const response = await previous.refetch();
    if (response.error) throw response.error;
    if (!response.data) setUncertain(false);
  });

  const moveFile = (index: number, offset: number) => {
    const files = [...draft.files];
    const [file] = files.splice(index, 1);
    files.splice(index + offset, 0, file);
    setDraft({ ...draft, files });
  };
  const retry = () => {
    setError("");
    setDraft({ ...draft, id: crypto.randomUUID() });
  };

  return <InlineCard>
    <InlineCardHeader icon={<Mail className="size-3.5" />} title={t("epost.draft_title")} status={mode === "sandbox" ? <span>{t("epost.test_mode")}</span> : undefined}
      actions={onClose ? <Button variant="ghost" size="icon-xs" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X /></Button> : undefined} />
    <fieldset disabled={locked} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
      {(["sender", "recipient"] as const).map(kind => <fieldset key={kind} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">{t(`epost.${kind}`)}</legend>
        <div className="grid grid-cols-[minmax(5rem,0.45fr)_minmax(0,1fr)] gap-2">
        {addressKeys.map(key => <label key={key} className={key === "name" || key === "street" ? "col-span-2 block space-y-1 text-xs" : "block space-y-1 text-xs"}>
          <span>{t(`epost.${key}`)}</span>
          <Input value={(kind === "sender" ? sender : recipient)[key]} maxLength={key === "postalCode" ? 16 : 80}
            autoComplete="off"
            onChange={event => setDraft(current => ({ ...current, [kind]: { ...emptyEpostAddress, ...current[kind], [key]: event.target.value } }))} />
        </label>)}
        </div>
      </fieldset>)}
      <label className="space-y-1 text-xs"><span>{t("epost.country")}</span>
        <Input value={country} maxLength={80} placeholder={t("epost.country_hint")} onChange={event => {
          const value = event.target.value;
          setDraft(current => ({ ...current, registered: value.trim() ? "none" : current.registered, recipient: { ...emptyEpostAddress, ...current.recipient, country: value } }));
        }} />
      </label>
      <label className="space-y-1 text-xs"><span>{t("epost.service")}</span>
        <select className="flex h-9 w-full rounded-md border bg-background px-2" value={draft.registered} disabled={Boolean(country.trim())} onChange={event => {
          const value = registeredOptions.find(option => option === event.target.value);
          if (value) setDraft(current => ({ ...current, registered: value }));
        }}>{registeredOptions.map(value => <option key={value} value={value}>{t(`epost.service_${value}`)}</option>)}</select>
      </label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.color} onChange={event => setDraft({ ...draft, color: event.target.checked })} />{t("epost.color")}</label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.duplex} onChange={event => setDraft({ ...draft, duplex: event.target.checked })} />{t("epost.duplex")}</label>
    </fieldset>
    <div className="space-y-2 px-5 pb-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("epost.included_pdfs")}</p>
        {!locked && draft.files.length < 20 && <Button variant="outline" size="sm" onClick={() => setPickingFiles(true)}><Paperclip />{t("epost.add_pdf")}</Button>}
      </div>
      <ul className="space-y-1">{draft.files.map((path, index) => <li key={`${path}:${index}`} className="flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-1">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" title={path} onClick={() => {
          const target = onOpenTarget ? resolvePathOpenTarget(path, openTargets, "attachment") : null;
          if (target && onOpenTarget) { onOpenTarget(target); return; }
          usePanelTabStore.getState().openTab(panelScope, { id: `file:${path}`, type: "artifact", preview: "pdf", label: fileName(path), value: path }, undefined, undefined, { besideChat: true });
        }}><FileText className="size-4" /><span className="truncate">{fileName(path)}</span></Button>
        {!locked && draft.files.length > 1 && <>
          <Button variant="ghost" size="icon-xs" disabled={index === 0} aria-label={t("epost.move_up", { file: fileName(path) })} onClick={() => moveFile(index, -1)}><ChevronUp /></Button>
          <Button variant="ghost" size="icon-xs" disabled={index === draft.files.length - 1} aria-label={t("epost.move_down", { file: fileName(path) })} onClick={() => moveFile(index, 1)}><ChevronDown /></Button>
        </>}
        {!locked && <Button variant="ghost" size="icon-xs" aria-label={t("epost.remove_pdf", { file: fileName(path) })} onClick={() => setDraft(current => ({ ...current, files: current.files.filter((_, i) => i !== index) }))}><X /></Button>}
      </li>)}</ul>
      {pickingFiles && !locked && <ProjectFilePicker pdfOnly client={client} workspaceId={draft.workspaceId} selected={draft.files}
        onClose={() => setPickingFiles(false)} onSelect={path => {
          setDraft(current => ({ ...current, files: [...current.files, path] }));
          setPickingFiles(false);
        }} />}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {final && <p role="status" className="text-sm">{t(final.mode === "sandbox" ? `epost.sandbox_${final.state}` : `epost.state_${final.state}`, { amount: money(final.amountCents), id: final.letterId ?? "" })}</p>}
    </div>
    <InlineCardFooter>
      {final?.state === "rejected" && <Button size="sm" variant="outline" disabled={!settings.data?.enabled} onClick={retry}>{t("epost.retry")}</Button>}
      {(final?.state === "pending" || final?.state === "accepted" || (final?.mode === "live" && final.state === "processed") || uncertain || previous.isError) &&
        <Button size="sm" variant="outline" disabled={busy || previous.isFetching} onClick={() => void refresh()}>{t("epost.check_status")}</Button>}
      {!final && !uncertain && !previous.isError &&
        <Button size="sm" disabled={locked || !ready} onClick={() => void review()}>{busy && <Loader2 className="animate-spin" />}{t("epost.review")}</Button>}
    </InlineCardFooter>
    <Dialog open={Boolean(quote)} onOpenChange={open => { if (!open && !busy) setQuote(null); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("epost.confirm")}</DialogTitle>
          <DialogDescription id={id}>{quote && t(quote.mode === "sandbox" ? "epost.sandbox_confirmation" : "epost.confirm_description", { amount: money(quote.amountCents), sheets: quote.sheets })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border bg-muted/25 p-3 text-sm"><div><strong>{t("epost.sender")}</strong> {Object.values(sender).join(", ")}</div>
          <div><strong>{t("epost.recipient")}</strong> {[recipient.name, recipient.street, recipient.postalCode, recipient.city, country].filter(Boolean).join(", ")}</div>
          <div>{t(`epost.service_${draft.registered}`)} · {t(draft.color ? "epost.color" : "epost.black_white")} · {t(draft.duplex ? "epost.duplex" : "epost.simplex")}</div>
          <ol className="list-decimal break-all ps-5">{draft.files.map((path, index) => <li key={`${path}:${index}`}>{fileName(path)}</li>)}</ol>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setQuote(null)}>{t("common.cancel")}</Button>
          <Button disabled={busy || !settings.data?.enabled} aria-describedby={id} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />}{t(quote?.mode === "sandbox" ? "epost.sandbox_submit" : "epost.submit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </InlineCard>;
}
