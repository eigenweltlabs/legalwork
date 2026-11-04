import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { FileText, Mail, X } from "lucide-react";
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
  const [attachment, setAttachment] = useState("");
  const [quote, setQuote] = useState<EpostQuote | null>(null);
  const [receipt, setReceipt] = useState<EpostReceipt | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const id = useId();
  const settings = useEpostSettings(client);
  const previous = useQuery({
    queryKey: ["epost-receipt", client.baseUrl, draft.workspaceId, draft.id], enabled: settings.data?.enabled === true, retry: false,
    queryFn: async () => {
      try { return await client.epostReceipt(draft.workspaceId, draft.id); }
      catch (cause) { if (cause instanceof LegalworkServerError && cause.status === 404) return null; throw cause; }
    },
  });
  const final = receipt ?? previous.data;
  const locked = Boolean(final || busy || quote || uncertain || previous.isFetching || !settings.data?.enabled);
  const sender = draft.sender ?? emptyEpostAddress;
  const recipient = draft.recipient ?? emptyEpostAddress;
  const ready = draft.files.length > 0 && addressKeys.every(key => sender[key].trim() && recipient[key].trim());
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
    try { setReceipt(await client.epostSubmit(draft.workspaceId, quote.reviewId)); }
    catch (cause) {
      if (!(cause instanceof LegalworkServerError) || cause.status >= 500) setUncertain(true);
      throw cause;
    } finally { setQuote(null); }
  });
  const refresh = () => run(async () => {
    const response = await previous.refetch();
    if (response.error) throw response.error;
    setReceipt(response.data ?? null);
    if (!response.data) setUncertain(false);
  });

  return <InlineCard>
    <InlineCardHeader icon={<Mail className="size-3.5" />} title={t("epost.draft_title")} status={<span>{t("epost.test_mode")}</span>}
      actions={onClose ? <Button variant="ghost" size="icon-xs" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X /></Button> : undefined} />
    <fieldset disabled={locked} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
      {(["sender", "recipient"] as const).map(kind => <fieldset key={kind} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">{t(`epost.${kind}`)}</legend>
        {addressKeys.map(key => <label key={key} className="block space-y-1 text-xs">
          <span>{t(`epost.${key}`)}</span>
          <Input value={(kind === "sender" ? sender : recipient)[key]} maxLength={key === "postalCode" ? 16 : 80}
            onChange={event => setDraft(current => ({ ...current, [kind]: { ...emptyEpostAddress, ...current[kind], [key]: event.target.value } }))} />
        </label>)}
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
      <p className="text-sm font-medium">{t("epost.included_pdfs")}</p>
      <ul className="space-y-1">{draft.files.map((path, index) => <li key={`${path}:${index}`} className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="max-w-full justify-start" title={path} onClick={() => {
          const target = onOpenTarget ? resolvePathOpenTarget(path, openTargets, "attachment") : null;
          if (target && onOpenTarget) { onOpenTarget(target); return; }
          usePanelTabStore.getState().openTab(panelScope, { id: `file:${path}`, type: "artifact", preview: "pdf", label: fileName(path), value: path }, undefined, undefined, { besideChat: true });
        }}><FileText className="size-4" /><span className="truncate">{fileName(path)}</span></Button>
        {!locked && <Button variant="ghost" size="icon-xs" aria-label={t("epost.remove_pdf", { file: fileName(path) })} onClick={() => setDraft(current => ({ ...current, files: current.files.filter((_, i) => i !== index) }))}><X /></Button>}
      </li>)}</ul>
      {!locked && draft.files.length < 20 && <div className="flex gap-2">
        <Input value={attachment} aria-label={t("epost.pdf_path")} placeholder={t("epost.pdf_path")} onChange={event => setAttachment(event.target.value)} />
        <Button variant="outline" size="sm" disabled={!/\.pdf$/i.test(attachment.trim()) || draft.files.includes(attachment.trim())}
          onClick={() => { setDraft(current => ({ ...current, files: [...current.files, attachment.trim()] })); setAttachment(""); }}>{t("epost.add_pdf")}</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {final && <p role="status" className="text-sm">{t(`epost.state_${final.state}`, { amount: money(final.amountCents), id: final.letterId ?? "" })}</p>}
    </div>
    <InlineCardFooter>
      {(final?.state === "pending" || final?.state === "accepted") || uncertain || previous.isError
        ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>{t("epost.check_status")}</Button>
        : <Button size="sm" disabled={locked || !ready} onClick={() => void review()}>{t("epost.review")}</Button>}
    </InlineCardFooter>
    <Dialog open={Boolean(quote)} onOpenChange={open => { if (!open && !busy) setQuote(null); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("epost.confirm")}</DialogTitle>
          <DialogDescription id={id}>{quote && t("epost.confirm_description", { amount: money(quote.amountCents), sheets: quote.sheets })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm"><div><strong>{t("epost.sender")}</strong> {Object.values(sender).join(", ")}</div>
          <div><strong>{t("epost.recipient")}</strong> {[recipient.name, recipient.street, recipient.postalCode, recipient.city, country].filter(Boolean).join(", ")}</div>
          <div>{t(`epost.service_${draft.registered}`)} · {t(draft.color ? "epost.color" : "epost.black_white")} · {t(draft.duplex ? "epost.duplex" : "epost.simplex")}</div>
          <ol className="list-decimal ps-5">{draft.files.map((path, index) => <li key={`${path}:${index}`}>{fileName(path)}</li>)}</ol>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setQuote(null)}>{t("common.cancel")}</Button>
          <Button disabled={busy || !settings.data?.enabled} aria-describedby={id} onClick={() => void submit()}>{t("epost.submit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </InlineCard>;
}
