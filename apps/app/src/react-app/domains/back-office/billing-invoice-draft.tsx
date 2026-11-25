import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration } from "./time-duration";
import { TimeRecordPicker, TimeSelect } from "./time-settings-controls";
import { checkBillingNarrative } from "@legalwork/types/billing-narrative";
import {
  localWorkdayModel,
  type WorkdayModelOption,
} from "@legalwork/types/time-capture";
import {
  currencyScale,
  formatInvoiceMinor,
} from "@legalwork/types/invoice-template";
import {
  InvoiceDraftInputSchema,
  adjustedTimeEntry,
  appliesTimeAdjustment,
  isHourlyInvoiceLine,
  resolveTimePolicy,
  timeEntryPrice,
  type TimeEntry,
  type TimeInvoiceDraft,
} from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  useBillingAction,
  type BillingProps,
} from "./billing-components";
import { BillingInvoicePdf } from "./billing-invoice-pdf";
import { InvoiceApprovalPane } from "./invoice-approval-pane";
import { openInvoiceDocument } from "./invoice-document-actions";
import { BillingPreferences } from "./billing-preferences";
import { formatFee } from "./billing-amounts";
import { entryStatusKeys, labelForCode } from "./timesheet-labels";
import { invoiceEntryAccess } from "./invoice-entry-access";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Surface } from "../../design-system/surface";
import { timeRoutes } from "./time-routes";

const invoiceWordingRules = {
  spelling: "invoiceReview.rule.spelling",
  language: "invoiceReview.rule.language",
  actionFirst: "invoiceReview.rule.actionFirst",
  activityLabels: "invoiceReview.rule.activityLabels",
  terminology: "invoiceReview.rule.terminology",
  narrativeExample: "invoiceReview.rule.narrativeExample",
  uploadedGuideline: "invoiceReview.rule.uploadedGuideline",
};

type DraftProps = BillingProps & {
  client: Pick<LegalworkServerClient, "downloadTimesheetDraft">;
  documentClient?: LegalworkServerClient;
  initialMatterId: string;
  initialClientId: string;
  initialEntry?: TimeEntry;
  workdayModels?: WorkdayModelOption[];
  dates?: { from: string; to: string };
  onCancel: () => void;
  onReviewSubmitted: (entry: TimeEntry) => void;
  onIssued: () => void;
};

type NarrativeDecision = {
  revision: number;
  narrative: string;
} & ({ type: "edit" } | { type: "suggestion"; currentNarrative: string });

function minorUnits(value: string, scale: number) {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const decimalPlaces = String(scale).length - 1;
  const fraction = match[2] ?? "";
  if (fraction.length > decimalPlaces) return undefined;
  const result =
    Number(match[1]) * scale + Number(fraction.padEnd(decimalPlaces, "0"));
  return Number.isSafeInteger(result) ? result : undefined;
}

function updateCheck(set: Set<string>, id: string, checked: boolean) {
  const next = new Set(set);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

export function BillingInvoiceDraft({
  state,
  onCommand,
  client,
  documentClient,
  dates,
  initialMatterId, initialClientId, initialEntry,
  workdayModels,
  onCancel,
  onReviewSubmitted,
  onIssued,
}: DraftProps) {
  const locale = useLocale();
  const approvalPane = useContext(InvoiceApprovalPane);
  const closeApproval = approvalPane?.close;
  useEffect(() => () => closeApproval?.(), [closeApproval]);
  const [rateEntry, setRateEntry] = useState<TimeEntry>();
  const matterInputId = useId();
  const clientInputId = useId();
  const durationFormat = useTimeDurationFormat();
  const initial = state.invoiceDraft?.input;
  const saved = !initialEntry && (!initialMatterId || initialMatterId === initial?.matterId) &&
    (!initialClientId || initialClientId === initial?.clientId) ? initial : undefined;
  const [stage, setStage] = useState<"entries" | "details">(saved ? "details" : "entries");
  const [from, setFrom] = useState(() => saved ? saved.period.from ?? "" : dates?.from ?? "");
  const [to, setTo] = useState(() => saved?.period.to ?? dates?.to ?? "");
  const [keepCutoff, setKeepCutoff] = useState(Boolean(saved && !saved.period.from));
  const invalidDates = Boolean(from && to && from > to);
  const candidates = useMemo(() => {
    const result = new Set<string>();
    const matters = new Map(state.matters.map(matter => [matter.id, matter]));
    const clientIds = new Set(state.clients.map(client => client.id));
    for (const entry of state.entries) {
      if (!entry.clientId || (initialClientId && entry.clientId !== initialClientId) ||
        !clientIds.has(entry.clientId) || !matters.get(entry.matterId)?.clientIds.includes(entry.clientId) ||
        (to && entry.date > to) || (from && entry.date < from) ||
        !invoiceEntryAccess(state, entry).authorized) continue;
      result.add(entry.matterId);
    }
    return result;
  }, [state, from, to, initialClientId]);
  const orderedMatters = useMemo(() => [...state.matters]
    .sort((a, b) => Number(candidates.has(b.id)) - Number(candidates.has(a.id))), [state.matters, candidates]);
  const withWork = orderedMatters.filter(item => candidates.has(item.id));
  const [matterId, setMatter] = useState(() => saved?.matterId || initialMatterId || (withWork.length === 1 ? withWork[0].id : ""));
  const matter = state.matters.find(item => item.id === matterId);
  const clients = state.clients.filter(item => matter?.clientIds.includes(item.id));
  const [chosenClient, setClient] = useState(saved?.clientId || initialClientId);
  const soleClient = matter?.clientIds.length === 1 && clients.length === 1 ? clients[0] : undefined;
  const clientId = soleClient?.id ?? (clients.some(item => item.id === chosenClient) ? chosenClient : "");
  const [selected, setSelected] = useState(
    () => new Set(initialEntry ? [initialEntry.id] : saved?.entries.map(entry => entry.id)),
  );
  const [decisions, setDecisions] = useState(() => {
    const initial = new Map<string, NarrativeDecision>();
    const edited = new Map(saved?.edits?.map(({ id, narrative }) => [id, narrative]));
    const accepted = new Set(saved?.wording);
    for (const line of state.invoiceDraft?.lines ?? []) {
      const { id, revision, narrative } = line.entry;
      const edit = edited.get(id);
      if (edit !== undefined) initial.set(id, { type: "edit", revision, narrative: edit });
      if (accepted.has(id)) initial.set(id, { type: "suggestion", revision, narrative, currentNarrative: line.currentNarrative });
    }
    return initial;
  });
  const [model, setModel] = useState("");
  const models = [
    ...(workdayModels ?? []),
    ...(state.scope === "local"
      ? [{ ...localWorkdayModel, label: t("invoiceReview.on_device") }]
      : []),
  ];
  const chosenModel = models.find(
    ({ workspaceId, providerID, modelID }) =>
      JSON.stringify([workspaceId, providerID, modelID]) === model,
  );
  const [fixed, setFixed] = useState(saved?.pricing.mode === "fixed");
  const [currency, setCurrency] = useState(
    saved?.pricing.mode === "fixed" ? saved.pricing.currency : "",
  );
  const [fixedPrice, setFixedPrice] = useState(
    saved?.pricing.mode === "fixed"
      ? String(
          saved.pricing.amountMinor / currencyScale(saved.pricing.currency),
        )
      : "",
  );
  const [showHours, setShowHours] = useState(
    saved?.pricing.mode === "fixed" && saved.pricing.showHours,
  );
  const [reduction, setReduction] = useState(
    saved?.reduction?.adjustment.type ?? "",
  );
  const [scope, setScope] = useState(saved?.reduction?.scope.type ?? "all");
  const [scopeIds, setScopeIds] = useState(
    new Set(
      saved?.reduction?.scope.type === "all" ? [] : saved?.reduction?.scope.ids,
    ),
  );
  const [targetBasis, setTargetBasis] = useState(
    saved?.reduction?.adjustment.type === "target"
      ? saved.reduction.adjustment.basis
      : "selection",
  );
  const [adjustmentValue, setAdjustmentValue] = useState(() => {
    const adjustment = saved?.reduction?.adjustment;
    if (adjustment?.type === "percent")
      return String(adjustment.basisPoints / 100);
    if (adjustment?.type === "target" && state.invoiceDraft)
      return String(
        adjustment.amountMinor / currencyScale(state.invoiceDraft.currency),
      );
    return "";
  });
  const { send, error, pending } = useBillingAction(onCommand);
  const [saving, setSaving] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const stageTitle = useRef<HTMLHeadingElement>(null);
  const [pricingOpen, setPricingOpen] = useState(Boolean(saved?.pricing.mode === "fixed" || saved?.reduction));
  const serviceDate = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  const request = useRef<{ revision: string; id: string } | undefined>(
    undefined,
  );
  const people = new Map(state.people.map(({ id, name }) => [id, name]));
  const rows = state.entries
    .filter(
      (entry) =>
        matterId &&
        clientId &&
        (entry.status === "confirmed" ||
          entry.status === "submitted" ||
          entry.status === "approved") &&
        entry.matterId === matterId &&
        (!entry.clientId || entry.clientId === clientId) &&
        (!to || entry.date <= to) &&
        (!from || entry.date >= from),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const draft = state.invoiceDraft;
  const adjustments = state.adjustments ?? [];
  const authorizedRows = rows.map((entry) => {
    const { policy, direct, authorized } = invoiceEntryAccess(state, entry, clientId);
    const currentReview = resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId);
    const currentSolo = state.scope === "local" && currentReview.soloApproval;
    const canAssign = entry.status === "confirmed" ? entry.workerId === state.userId :
      (currentReview.reviewerId === state.userId || (currentSolo && !currentReview.reviewerId)) && (entry.workerId !== state.userId || currentSolo);
    return { entry: direct ? { ...entry, ...timeEntryPrice(policy, entry.workerId) } : entry, policy, authorized, canAssign, direct };
  });
  const hourlyCurrencies = [...new Set(authorizedRows.flatMap(({ entry, authorized }) =>
    authorized && selected.has(entry.id) && isHourlyInvoiceLine(entry) ? [entry.currency] : [],
  ))].sort();
  const hourlyCurrency = hourlyCurrencies.length === 1 ? hourlyCurrencies[0] : undefined;
  const currencySupported = state.supportsHourlyInvoiceCurrency === true;
  const legacyCutoffUnavailable = !fixed && keepCutoff && !currencySupported && Boolean(hourlyCurrency) &&
    authorizedRows.some(({ entry, authorized }) => authorized && (!isHourlyInvoiceLine(entry) || entry.currency !== hourlyCurrency));
  const checks = authorizedRows.map(({ entry, policy, authorized, canAssign, direct }) => {
    const line = adjustedTimeEntry(entry, adjustments);
    const picked = authorized && selected.has(entry.id);
      const decision = decisions.get(entry.id);
    const edited = decision?.type === "edit" && decision.revision === entry.revision
      ? decision.narrative
      : undefined;
    const accepted = decision?.type === "suggestion" &&
      decision.revision === entry.revision && decision.currentNarrative === line.narrative
      ? decision.narrative
      : undefined;
    const preparedLine = draft?.lines.find(
      (item) =>
        item.entry.id === entry.id &&
        item.entry.revision === entry.revision &&
        item.currentNarrative === line.narrative &&
        item.entry.narrative === (edited ?? accepted ?? line.narrative),
    );
    const check = checkBillingNarrative(line, policy);
    const fallback = preparedLine ? preparedLine.suggestedNarrative : check?.narrative;
    const suggested = preparedLine?.modelRule
      ? preparedLine.suggestedNarrative
      : accepted ?? (edited === undefined ? fallback : undefined);
    const rules = preparedLine
      ? [...preparedLine.rules]
      : [...(check?.replacements ?? [])].map(
          ([before, after]) => before + " → " + after,
        );
    const actionFirst = preparedLine
      ? preparedLine.actionFirst
      : check?.actionFirst;
    if (actionFirst) rules.push(t("back_office.billing.action_first"));
    return { entry, line, preparedLine, rules, suggested, edited, accepted, authorized, picked, canAssign, direct };
  });
  const suggestedWording = checks.flatMap(({ picked, line, suggested, accepted }) =>
    picked && suggested && accepted !== suggested
      ? [[line.id, { type: "suggestion", revision: line.revision, narrative: suggested, currentNarrative: line.narrative }] satisfies [string, NarrativeDecision]]
      : [],
  );
  const included = checks
    .filter(({ picked }) => picked)
    .map(({ entry }) => entry);
  const missingRate = included.some(entry => !isHourlyInvoiceLine(entry));
  const mixedCurrencies = hourlyCurrencies.length > 1;
  const hourlyPricingMissing = !fixed && (missingRate || mixedCurrencies);
  const linkedAdjustments = adjustments.filter((item) =>
    included.some((entry) => appliesTimeAdjustment(entry, item)),
  );
  const pendingAdjustments = linkedAdjustments.some(
    ({ status }) => status === "pending",
  );
  const approvedAdjustments = linkedAdjustments.filter(
    ({ status }) => status === "approved",
  );
  const invoiceCurrency = fixed ? currency : hourlyCurrency;
  const scale =
    invoiceCurrency && /^[A-Z]{3}$/.test(invoiceCurrency)
      ? currencyScale(invoiceCurrency)
      : 100;
  const selectedScope =
    scope === "people"
      ? new Set(included.map(({ workerId }) => workerId))
      : new Set(included.map(({ id }) => id));
  const selectionIds = [...selectedScope].filter((id) => scopeIds.has(id));
  const selectedWording = checks.flatMap(({ picked, entry, accepted }) =>
    picked && accepted !== undefined ? [{ id: entry.id, narrative: accepted }] : [],
  );
  const editedWording = checks.flatMap(({ picked, entry, edited }) =>
    picked && edited !== undefined ? [{ id: entry.id, narrative: edited }] : [],
  );
  const input = InvoiceDraftInputSchema.safeParse({
    matterId,
    clientId,
    period: { from: keepCutoff ? undefined : from || included[0]?.date, to: to || included.at(-1)?.date },
    entries: included.map(({ id, revision }) => ({ id, revision })),
    adjustmentVersions: approvedAdjustments.map(({ id, revision }) => ({
      id,
      revision,
    })),
    wording: selectedWording.map(({ id }) => id),
    expectedSuggestions: selectedWording.length ? selectedWording : undefined,
    edits: editedWording.length ? editedWording : undefined,
    pricing: fixed
      ? {
          mode: "fixed",
          currency,
          amountMinor: minorUnits(fixedPrice, scale),
          showHours,
        }
      : { mode: "hourly", currency: currencySupported ? hourlyCurrency : undefined },
    reduction:
      (reduction && {
        scope:
          scope === "all"
            ? { type: scope }
            : { type: scope, ids: selectionIds },
        adjustment:
          reduction === "percent"
            ? { type: reduction, basisPoints: minorUnits(adjustmentValue, 100) }
            : {
                type: reduction,
                amountMinor: minorUnits(adjustmentValue, scale),
                basis: targetBasis,
              },
      }) ||
      undefined,
  });
  const currentClient = clients.find(({ id }) => id === clientId);
  // The last revision of an older draft may have its hourly currency only in the result.
  const matchingInput = input.success && draft?.input.pricing.mode === "hourly" &&
      draft.input.pricing.currency === undefined && input.data.pricing.mode === "hourly" &&
      input.data.pricing.currency === draft.currency
    ? { ...input.data, pricing: { mode: "hourly" } }
    : input.data;
  const currentRates = new Map(included.map(entry => [entry.id, entry]));
  const pricingChanged = !fixed && draft?.lines.some(({ entry }) => {
    const current = currentRates.get(entry.id);
    return current && (entry.hourlyRate !== current.hourlyRate || entry.currency !== current.currency);
  });
  const visibleDraft =
    draft &&
    JSON.stringify(matchingInput) === JSON.stringify(draft.input) &&
    !legacyCutoffUnavailable &&
    !hourlyPricingMissing &&
    !pricingChanged &&
    !pendingAdjustments &&
    (!state.template ||
      state.template.revision === draft.snapshot.template.revision) &&
    (currentClient?.billingAddress === undefined ||
      currentClient.billingAddress === draft.snapshot.clientAddress)
      ? draft
      : undefined;
  const money = (minor: number, currencyCode: string) =>
    formatInvoiceMinor(locale, currencyCode, minor);

  function changeMatter(id: string) {
    setMatter(id);
    setClient("");
    resetSelection();
  }
  function resetSelection() {
    setKeepCutoff(false);
    setSelected(new Set());
    setDecisions(new Map());
    setFixed(false);
    setCurrency("");
    setFixedPrice("");
    setShowHours(false);
    setReduction("");
    setScopeIds(new Set());
    setAdjustmentValue("");
    setPricingOpen(false);
  }
  function changeWording(id: string, decision: NarrativeDecision | undefined) {
    setDecisions((previous) => {
      const next = new Map(previous);
      if (decision === undefined) next.delete(id);
      else next.set(id, decision);
      return next;
    });
  }
  async function issue(draft: TimeInvoiceDraft) {
    if (request.current?.revision !== draft.revision)
      request.current = { revision: draft.revision, id: crypto.randomUUID() };
    try {
      await send({
        type: "issueInvoice",
        id: draft.id,
        revision: draft.revision,
        requestId: request.current.id,
      });
      onIssued();
    } catch {
      // The same request ID resumes an issuance after a failed response.
    }
  }

  function showStage(next: typeof stage) {
    setStage(next);
    requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = 0;
      stageTitle.current?.focus({ preventScroll: true });
    });
  }

  async function saveDraft() {
    if (visibleDraft) {
      approvalPane?.open();
      return;
    }
    if (!input.success || hourlyPricingMissing || invalidDates || pendingAdjustments || legacyCutoffUnavailable) return;
    setSaving(true);
    try {
      await send({ type: "prepareInvoice", draft: input.data });
      approvalPane?.open();
    } catch {
      // The draft form keeps its inputs and shows the server error.
    } finally {
      setSaving(false);
    }
  }

  const selectableRows = checks.filter(row => row.authorized);
  const unavailableRows = checks.filter(row => !row.authorized && row.entry.billable);
  const editingSelection = stage === "entries";
  const amounts = new Map(visibleDraft?.lines.map(line => [line.entry.id, line]));
  const rateGroups = new Map(included.map(entry =>
    [JSON.stringify([entry.workerId, entry.date, entry.projectId, entry.hourlyRate, entry.currency, entry.nonHourlyApproval]), entry]));
  const approvalContent = visibleDraft ? (
    <div className="bo-invoice-draft-preview">
      <header className="bo-invoice-preview-heading">
        <h2>{t("invoiceReview.approval_tab")}</h2>
        <strong>{money(visibleDraft.totalMinor, visibleDraft.currency)}</strong>
      </header>
      <div className="bo-invoice-preview-meta">
        {visibleDraft.input.reduction && (
          <>
            <span>
              {t("invoiceReview.selected_amount", {
                amount: money(
                  visibleDraft.selectedTotalMinor,
                  visibleDraft.currency,
                ),
              })}
            </span>
            <span>
              {t("invoiceReview.protected_amount", {
                amount: money(
                  visibleDraft.protectedMinor,
                  visibleDraft.currency,
                ),
              })}
            </span>
          </>
        )}
        <span>
          {visibleDraft.snapshot.template.revision === 0 ? t("invoiceReview.default_template") :
            t("invoiceReview.template_name", { title: visibleDraft.snapshot.template.word?.name ?? visibleDraft.snapshot.template.title })}
        </span>
        {state.canManage && <Link className={buttonVariants({ size: "xs", variant: "ghost" })}
          to="/settings/billing?tab=invoice-template">{t("invoiceReview.manage_template")}</Link>}
      </div>
      {state.supportsInvoiceWordingReview &&
        models.length > 0 &&
        !visibleDraft.approval && (
          <div className="bo-invoice-preview-meta">
            <TimeSelect label={t("invoiceReview.model")} placeholder={t("invoiceReview.choose_model")}
              value={model} disabled={pending} options={models.map(({ workspaceId, providerID, modelID, label }) =>
                ({ id: JSON.stringify([workspaceId, providerID, modelID]), name: label }))} onChange={setModel} />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !chosenModel}
              onClick={() => {
                if (chosenModel) {
                  const { workspaceId, providerID, modelID } = chosenModel;
                  void send({
                    type: "reviewInvoiceWording",
                    id: visibleDraft.id,
                    revision: visibleDraft.revision,
                    model: { workspaceId, providerID, modelID },
                  }).catch(() => {});
                }
              }}
            >
              {t("invoiceReview.ai_review")}
            </Button>
            {visibleDraft.modelWording && (
              <span role="status">
                {t("invoiceReview.ai_results", {
                  count: visibleDraft.modelWording.length,
                })}
              </span>
            )}
          </div>
        )}
      <BillingInvoicePdf
        key={JSON.stringify([state.scope, visibleDraft.id, visibleDraft.revision])}
        client={client}
        scope={state.scope}
        id={visibleDraft.id}
        revision={visibleDraft.revision}
        openWord={approvalPane && documentClient ? () => openInvoiceDocument(approvalPane, documentClient, state, {
          id: visibleDraft.id + ":" + visibleDraft.revision, format: "docx", name: t("invoiceReview.word_draft"),
          loadFile: () => client.downloadTimesheetDraft(visibleDraft.id, state.scope, "docx", { revision: visibleDraft.revision }),
        }) : undefined}
      >
        {pdfReady => <footer className="bo-invoice-footer justify-end">
          {!visibleDraft.snapshot.clientAddress && <p className="me-auto text-muted-foreground">{t("invoiceReview.address_required")}</p>}
          {error && <p className="me-auto text-destructive" role="alert">{error}</p>}
          {visibleDraft.approval ? <Button size="sm" disabled={pending || !pdfReady}
            onClick={() => void issue(visibleDraft)}>{t("back_office.billing.issue")}</Button>
            : <Button size="sm" disabled={pending || !pdfReady || !visibleDraft.snapshot.clientAddress}
              onClick={() => void send({ type: "approveInvoice", id: visibleDraft.id, revision: visibleDraft.revision }).catch(() => {})}>
              {t("invoiceReview.approve")}
            </Button>}
        </footer>}
      </BillingInvoicePdf>
    </div>
  ) : <p className="px-5 py-4 text-sm text-muted-foreground" role="status">{t("invoiceReview.refresh_preview")}</p>;
  return (
    <div className="bo-billing-body bo-invoice-draft">
      <header className="bo-invoice-header">
        <Button size="icon-sm" variant="ghost" onClick={editingSelection ? onCancel : () => showStage("entries")} disabled={pending} aria-label={t("common.back")} title={t("common.back")}>
          <ArrowLeft size={16} />
        </Button>
        <h2>{t("invoiceReview.create")}</h2>
      </header>
      <div className="bo-invoice-scroll" ref={scroll}>
      <fieldset disabled={pending} className="bo-invoice-content">
        {editingSelection ? <>
          <div className="bo-invoice-parties">
            <Field className="min-w-0">
              <FieldLabel htmlFor={matterInputId}>{t("back_office.billing.matter")}</FieldLabel>
              <TimeRecordPicker id={matterInputId} label={t("back_office.billing.matter")} placeholder={t("invoiceReview.choose_matter")}
                value={matterId} options={orderedMatters} disabled={pending} onChange={changeMatter} />
            </Field>
            {soleClient ? <div className="flex flex-col gap-3">
              <span className="text-sm font-medium">{t("back_office.billing.client")}</span>
              <p className="min-h-9 content-center break-words text-sm">{soleClient.name}</p>
            </div> : matter && (clients.length ? (
              <Field className="min-w-0">
                <FieldLabel htmlFor={clientInputId}>{t("back_office.billing.client")}</FieldLabel>
                <TimeRecordPicker id={clientInputId} label={t("back_office.billing.client")} placeholder={t("invoiceReview.choose_client")}
                  value={clientId} options={clients} disabled={pending}
                  onChange={value => { setClient(value); resetSelection(); }} />
              </Field>
            ) : <p className="self-end pb-2 text-sm text-muted-foreground">{t("invoiceReview.no_matter_client")}</p>)}
          </div>
          {matter && clientId && <section className="mt-6 space-y-3">
            <Collapsible>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 ref={stageTitle} tabIndex={-1} className="text-base font-semibold focus:outline-none">{t("timeWorkspace.entries")}</h3>
                <CollapsibleTrigger className="group" render={<Button variant={from || to ? "outline" : "ghost"} size="sm" />}>
                  {t("invoiceReview.filter_dates")}<ChevronRight className="group-aria-expanded:rotate-90" />
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="bo-invoice-settings px-0 pt-3">
                <label>{t("back_office.billing.from")}
                  <Input type="date" value={from} onChange={event => { setFrom(event.target.value); setKeepCutoff(false); }} />
                </label>
                <label>{t("back_office.billing.to")}
                  <Input type="date" value={to} onChange={event => { setTo(event.target.value); setKeepCutoff(false); }} />
                </label>
              </CollapsibleContent>
            </Collapsible>
            {invalidDates ? <p className="text-sm text-destructive" role="alert">{t("invoiceReview.date_order")}</p> :
              !selectableRows.length && <Empty variant="ghost"><EmptyHeader><EmptyTitle>{t("invoiceReview.none_ready")}</EmptyTitle>
                <EmptyDescription>{t("invoiceReview.change_period")}</EmptyDescription></EmptyHeader></Empty>}
            {selectableRows.length > 0 && <Surface className="overflow-hidden">
              <Table>
                <TableHeader><TableRow>
                  <TableHead className="w-10">
                    <Checkbox aria-label={t("back_office.billing.select_all")} checked={included.length === selectableRows.length}
                      indeterminate={included.length > 0 && included.length < selectableRows.length}
                      onCheckedChange={checked => {
                        setKeepCutoff(false);
                        setSelected(new Set(checked ? selectableRows.map(({ entry }) => entry.id) : []));
                      }} />
                  </TableHead>
                  <TableHead>{t("native.description")}</TableHead>
                  <TableHead className="text-end">{t("timesheets.ledger.billable")}</TableHead>
                </TableRow></TableHeader>
                <TableBody>{selectableRows.map(({ entry, line, picked, direct }) => <TableRow key={entry.id}>
                  <TableCell>
                    <Checkbox aria-label={t("back_office.billing.select_line", { label: line.narrative })} checked={picked}
                      onCheckedChange={checked => {
                        setKeepCutoff(false);
                        setSelected(previous => updateCheck(previous, entry.id, checked));
                      }} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="font-medium">{line.narrative}</div>
                    <small className="text-muted-foreground">
                      <time dateTime={entry.date}>{serviceDate.format(new Date(entry.date + "T00:00:00"))}</time>
                      {" · "}{people.get(entry.workerId) ?? entry.workerId}
                      {direct && <>{" · "}{t(entryStatusKeys.approved)}</>}
                    </small>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatTimeDuration(line.billableMinutes, durationFormat)}</TableCell>
                </TableRow>)}</TableBody>
              </Table>
            </Surface>}
            {unavailableRows.length > 0 && <details key={selectableRows.length === 0 ? "all" : "some"} className="bo-invoice-unavailable" open={selectableRows.length === 0 || undefined}>
              <summary><ChevronRight size={15} />{t("invoiceReview.excluded_entries", { count: unavailableRows.length })}</summary>
              <ul>{unavailableRows.map(({ entry, canAssign, direct }) => <li key={entry.id}>
                <div>{entry.narrative}<small>{serviceDate.format(new Date(entry.date + "T00:00:00"))} · {people.get(entry.workerId) ?? entry.workerId}</small></div>
                <div>
                  {t(entryStatusKeys[entry.status])}
                  {entry.legacy ? <small>{entry.workerId === state.userId && entry.status === "confirmed" ?
                    <Link className="bo-invoice-link" state={{ timeWorkspaceTab: "entries" }} to={timeRoutes.timesheets + "?date=" + entry.date}>
                      {t("invoiceReview.imported_edit")}</Link> : t("invoiceReview.imported_locked")}</small>
                  : !entry.billable ? <small>{t("timesheets.ledger.nonbillable")}</small>
                  : state.supportsBillingClientAssignment && entry.billable && !entry.clientId && canAssign ? (
                    <Button size="xs" variant="outline" disabled={pending}
                      onClick={() => void send({ type: "assignBillingClient", id: entry.id, revision: entry.revision, clientId }).catch(() => {})}>
                      {t("invoiceReview.assign_recipient", { client: currentClient?.name ?? "" })}
                    </Button>
                  ) : !entry.clientId ? <small>{t("invoiceReview.missing_recipient")}</small>
                  : entry.status === "submitted" && canAssign ? (
                    <Button size="xs" variant="outline" onClick={() => onReviewSubmitted(entry)}>{t("invoiceReview.review_open")}</Button>
                  ) : entry.status === "submitted" ? <small>{t("invoiceReview.await_review")}</small>
                  : entry.status === "confirmed" && !direct ? (
                    <small>{entry.workerId === state.userId ? <Link className="bo-invoice-link" state={{ timeWorkspaceTab: "entries" }}
                      to={timeRoutes.timesheets + "?date=" + entry.date}>{t("invoiceReview.submit_open")}</Link> : t("invoiceReview.await_submission")}</small>
                  ) : <small>{t("invoiceReview.other_reviewer")}</small>}
                </div>
              </li>)}</ul>
            </details>}
          </section>}
        </> : <>
          <h3 ref={stageTitle} tabIndex={-1} className="text-base font-semibold focus:outline-none">{t("invoiceReview.details")}</h3>
          <p className="mt-1 mb-4 text-muted-foreground">{matter?.name}{" · "}{currentClient?.name}</p>
          {legacyCutoffUnavailable && (
            <p role="status" className="mb-3">{t("invoiceReview.legacy_currency_cutoff")}</p>
          )}
          <details className="bo-invoice-disclosure" open={pricingOpen || hourlyPricingMissing}
            onToggle={event => setPricingOpen(event.currentTarget.open)}>
            <summary><ChevronRight size={15} />{t("invoiceReview.pricing_details")}
              <span className="ms-auto text-xs text-muted-foreground">
                {t(fixed ? "invoiceReview.fixed" : "invoiceReview.hourly")}{invoiceCurrency && " · " + invoiceCurrency}
              </span>
            </summary>
            <div className="bo-invoice-settings bo-invoice-fee-basis">
              <label>
                {t("invoiceReview.pricing")}
                <TimeSelect label={t("invoiceReview.pricing")} value={fixed ? "fixed" : "hourly"} disabled={pending}
                  options={[{ id: "hourly", name: t("invoiceReview.hourly") }, { id: "fixed", name: t("invoiceReview.fixed") }]}
                  onChange={value => { setFixed(value === "fixed"); if (!currency) setCurrency(hourlyCurrency ?? "EUR"); }} />
              </label>
              {fixed && <label>
                {t("invoiceReview.agreed_price")}
                <Input inputMode="decimal" value={fixedPrice} onChange={event => setFixedPrice(event.target.value)} />
              </label>}
              {fixed && <label>
                {t("invoiceReview.currency")}
                <Input maxLength={3} value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())} />
              </label>}
            </div>
            {fixed && <div className="bo-invoice-options">
              <label>
                <Checkbox checked={showHours} disabled={pending} onCheckedChange={setShowHours} />
                {t("invoiceReview.show_hours")}
              </label>
            </div>}
            {!fixed && rateGroups.size > 0 && <div className="bo-invoice-rates">
              <h4>{t("invoiceReview.timekeeper_rates")}</h4>
              {hourlyPricingMissing && <p className="text-sm text-muted-foreground" role="status">
                {t(mixedCurrencies ? "invoiceReview.mixed_rates" : "invoiceReview.missing_rate_help")}
              </p>}
              <ul>{[...rateGroups].map(([key, entry]) => <li key={key}>
                <div>
                  <strong>{people.get(entry.workerId) ?? entry.workerId}</strong>
                  <small>{serviceDate.format(new Date(entry.date + "T00:00:00"))}</small>
                </div>
                <span className="text-sm tabular-nums">{isHourlyInvoiceLine(entry)
                  ? t("invoiceReview.rate_per_hour", { rate: formatFee(locale, entry.hourlyRate, entry.currency) })
                  : t(entry.nonHourlyApproval ? "invoiceReview.fixed_agreement" : "invoiceReview.no_rate")}</span>
                {state.canManage && <Button size="xs" variant="outline" onClick={() => setRateEntry(entry)}>
                  {t(entry.status === "approved" ? "invoiceReview.rate_settings" : "invoiceReview.edit_rate")}
                </Button>}
              </li>)}</ul>
            </div>}
            {included.length > 0 && <details className="bo-invoice-reduction" open={reduction ? true : undefined}>
              <summary><ChevronRight size={14} />{t("invoiceReview.reduction")}</summary>
              <div className="bo-invoice-settings">
                <label>
                  {t("invoiceReview.reduction")}
                  <TimeSelect label={t("invoiceReview.reduction")} value={reduction} disabled={pending}
                    options={[{ id: "", name: t("invoiceReview.no_reduction") }, { id: "percent", name: t("invoiceReview.percent") }, { id: "target", name: t("invoiceReview.target") }]}
                    onChange={value => { setReduction(value === "percent" || value === "target" ? value : ""); setAdjustmentValue(""); }} />
                </label>
                {reduction && <>
                  <label>
                    {t("invoiceReview.reduce_scope")}
                    <TimeSelect label={t("invoiceReview.reduce_scope")} value={scope} disabled={pending}
                      options={[{ id: "all", name: t("invoiceReview.all_lines") }, { id: "people", name: t("invoiceReview.people") }, { id: "entries", name: t("invoiceReview.lines") }]}
                      onChange={value => { setScope(value === "entries" || value === "people" ? value : "all"); setScopeIds(new Set()); }} />
                  </label>
                  {reduction === "target" && <label>
                    {t("invoiceReview.target_scope")}
                    <TimeSelect label={t("invoiceReview.target_scope")} value={targetBasis} disabled={pending}
                      options={[{ id: "selection", name: t("invoiceReview.selected_target") }, { id: "invoice", name: t("invoiceReview.invoice_target") }]}
                      onChange={value => setTargetBasis(value === "invoice" ? value : "selection")} />
                  </label>}
                  <label>
                    {t(reduction === "target" ? "invoiceReview.target" : "invoiceReview.percent")}
                    <Input inputMode="decimal" value={adjustmentValue} onChange={event => setAdjustmentValue(event.target.value)} />
                  </label>
                </>}
              </div>
              {reduction && scope !== "all" && <div className="bo-invoice-options">
                {[...selectedScope].map(id => <label key={id}>
                  <Checkbox checked={scopeIds.has(id)} disabled={pending} onCheckedChange={checked => setScopeIds(previous => updateCheck(previous, id, checked))} />
                  {scope === "people" ? people.get(id) ?? id : included.find(entry => entry.id === id)?.narrative}
                </label>)}
              </div>}
            </details>}
          </details>
          {included.length > 0 && <details className="bo-invoice-disclosure" open={suggestedWording.length > 0 || undefined}>
            <summary><ChevronRight size={15} />{t("invoiceReview.result")}</summary>
            {suggestedWording.length > 0 && <div className="bo-invoice-line-actions">
              <Button size="sm" variant="outline"
                onClick={() => setDecisions(previous => new Map([...previous, ...suggestedWording]))}>
                {t("invoiceReview.apply_suggestions")}
              </Button>
            </div>}
            <Table className="bo-invoice-line-table">
              <TableHeader><TableRow>
                <TableHead className="bo-invoice-service" scope="col">{t("invoiceReview.service")}</TableHead>
                <TableHead scope="col">{t("invoiceReview.result")}</TableHead>
                {visibleDraft && <TableHead className="bo-invoice-amount bo-billing-number" scope="col">
                  {t("invoiceReview.billed")}
                </TableHead>}
              </TableRow></TableHeader>
              <TableBody>
                {checks.filter(row => row.picked).map(({ entry, line, preparedLine, rules, suggested, edited, accepted }) => {
                  const previewLine = amounts.get(entry.id);
                  const original = entry.submittedNarrative ?? entry.narrative;
                  const wording = edited ?? previewLine?.entry.narrative ?? accepted ?? line.narrative;
                  const hasDetails = original !== wording || rules.length > 0 || preparedLine?.modelRule || preparedLine?.guidelineVersions?.length;
                  return <TableRow key={entry.id}>
                    <TableCell className="bo-invoice-service">
                      <time dateTime={entry.date}>{serviceDate.format(new Date(entry.date + "T00:00:00"))}</time>
                      <small>{people.get(entry.workerId) ?? entry.workerId}</small>
                      {entry.authorId !== entry.workerId && <small>{t("invoiceReview.author", { name: people.get(entry.authorId) ?? entry.authorId })}</small>}
                      <small>{formatTimeDuration(line.billableMinutes, durationFormat)}</small>
                    </TableCell>
                    <TableCell>
                      <Textarea maxLength={2000} className="min-h-9 py-1.5"
                        aria-label={t("invoiceReview.edit_wording", { label: line.narrative })} value={wording}
                        onChange={event => changeWording(entry.id, { type: "edit", revision: entry.revision, narrative: event.target.value })} />
                      {suggested && suggested !== wording && <div className="bo-invoice-wording-suggestion">
                        <small>{t("back_office.billing.suggestion")}</small>
                        <p>{suggested}</p>
                        <Button size="xs" variant="outline" aria-label={t("invoiceReview.apply_suggestion", { label: line.narrative })}
                          onClick={() => changeWording(entry.id, { type: "suggestion", revision: entry.revision, narrative: suggested, currentNarrative: line.narrative })}>
                          {t("back_office.billing.apply")}
                        </Button>
                      </div>}
                      {hasDetails ? <details className="bo-invoice-line-details">
                        <summary><ChevronRight size={13} />{t("invoiceReview.wording_details")}</summary>
                        {original !== wording && <p><small>{t("invoiceReview.original")}</small>{original}</p>}
                        {(preparedLine?.modelRule || rules.length > 0) && <p><small>{t("back_office.billing.wording_rule")}</small>
                          {preparedLine?.modelRule ? labelForCode(invoiceWordingRules, preparedLine.modelRule) : rules.join(" · ")}
                        </p>}
                        {preparedLine?.guidelineVersions?.map(version => <small key={version.id}>
                          {t("invoiceReview.guidelineVersion", { name: version.name, revision: version.revision, date: version.effectiveFrom })}
                        </small>)}
                      </details> : null}
                      {(edited !== undefined || accepted !== undefined) && <Button size="xs" variant="ghost"
                        onClick={() => changeWording(entry.id, undefined)}>{t("invoiceReview.reset_wording")}</Button>}
                    </TableCell>
                    {visibleDraft && <TableCell className="bo-invoice-amount bo-billing-number">
                      {previewLine && <>
                        {money(previewLine.amountMinor, visibleDraft.currency)}
                        {previewLine.baseAmountMinor !== previewLine.amountMinor && <small title={t("invoiceReview.base_amount")}>
                          <s>{money(previewLine.baseAmountMinor, visibleDraft.currency)}</s>
                        </small>}
                      </>}
                    </TableCell>}
                  </TableRow>;
                })}
              </TableBody>
            </Table>
          </details>}
        </>}
      </fieldset>
      </div>
      <footer className="bo-invoice-footer">
        <div className="bo-invoice-save-status">
          {error ? <p role="alert" className="bo-billing-error">{error}</p> :
            editingSelection ? (included.length > 0 ? <p>{t("invoiceReview.selected_entries", { count: included.length })}</p> :
              selectableRows.length > 0 && <p>{t("invoiceReview.choose_entry")}</p>) :
            pendingAdjustments ? <p role="status">{t("back_office.billing.invoice_correction_pending")}</p> :
            hourlyPricingMissing ? <p role="status">{t(mixedCurrencies ? "invoiceReview.mixed_rates_short" : "invoiceReview.rate_required")}</p> :
            visibleDraft ? <p role="status"><Check size={14} />{t(visibleDraft.approval ? "invoiceReview.approved" : "invoiceReview.saved")}</p> :
            included.length ? <p>{t("invoiceReview.selected_entries", { count: included.length })}
              {!input.success && !hourlyPricingMissing && <span>{t("invoiceReview.check_terms")}</span>}</p> :
            <p>{t("invoiceReview.choose_entry")}</p>}
        </div>
        <div className="bo-invoice-footer-actions">
          {editingSelection ? <Button size="sm" disabled={!included.length || invalidDates || pending}
            onClick={() => showStage("details")}>{t("common.continue")}</Button> : <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => showStage("entries")}>{t("invoiceReview.edit_selection")}</Button>
            <Button size="sm" variant={visibleDraft ? "outline" : "default"}
              disabled={!input.success || hourlyPricingMissing || invalidDates || pending || pendingAdjustments || legacyCutoffUnavailable} onClick={() => void saveDraft()}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {t(visibleDraft ? "back_office.billing.preview" : "invoiceReview.save_preview")}
            </Button>
          </>}
        </div>
      </footer>
      {approvalPane?.target && createPortal(approvalContent, approvalPane.target)}
      {rateEntry && <Dialog open onOpenChange={open => { if (!open) setRateEntry(undefined); }}>
        <DialogContent className="max-h-[min(85dvh,48rem)] overflow-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("invoiceReview.timekeeper_rates")}</DialogTitle>
            <DialogDescription>{t(rateEntry.status === "approved" ? "invoiceReview.approved_rate_help" : "invoiceReview.policy_rate_help")}</DialogDescription>
          </DialogHeader>
          <BillingPreferences state={state} onCommand={onCommand} section="rates"
            initialProjectId={rateEntry.projectId} initialMatterId={matterId} initialClientId={clientId}
            initialDate={rateEntry.date} initialWorkerId={rateEntry.workerId} />
        </DialogContent>
      </Dialog>}
    </div>
  );
}
