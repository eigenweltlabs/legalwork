import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TimeRecordPicker, TimeSelect } from "./time-settings-controls";
import { checkBillingNarrative } from "@legalwork/types/billing-narrative";
import {
  localWorkdayModel,
  type WorkdayModelOption,
} from "@legalwork/types/time-capture";
import {
  currencyScale,
  formatInvoiceHours,
  formatInvoiceMinor,
} from "@legalwork/types/invoice-template";
import {
  InvoiceDraftInputSchema,
  adjustedTimeEntry,
  assignedTimeReviewer,
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
import { reviewPeriod } from "./billing-amounts";
import { BillingInvoicePdf } from "./billing-invoice-pdf";
import { entryStatusKeys, labelForCode } from "./timesheet-labels";
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
  initialMatterId: string;
  workdayModels?: WorkdayModelOption[];
  dates: { from: string; to: string };
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
  dates,
  initialMatterId,
  workdayModels,
  onCancel,
  onReviewSubmitted,
  onIssued,
}: DraftProps) {
  const locale = useLocale();
  const initial = state.invoiceDraft?.input;
  const saved =
    !initialMatterId || initialMatterId === initial?.matterId
      ? initial
      : undefined;
  const [matterId, setMatter] = useState(saved?.matterId ?? initialMatterId);
  const matter = state.matters.find((item) => item.id === matterId);
  const clients = state.clients.filter((item) =>
    matter?.clientIds.includes(item.id),
  );
  const [chosenClient, setClient] = useState(saved?.clientId ?? "");
  const soleClient =
    matter?.clientIds.length === 1 && clients.length === 1
      ? clients[0]
      : undefined;
  const clientId = soleClient?.id ?? chosenClient;
  const [from, setFrom] = useState(
    () => saved?.period.from ?? (dates.from || reviewPeriod().from),
  );
  const [to, setTo] = useState(
    () => saved?.period.to ?? (dates.to || reviewPeriod().to),
  );
  const [allOpen, setAllOpen] = useState(Boolean(saved && !saved.period.from));
  const [excluded, setExcluded] = useState<Set<string>>(
    () =>
      new Set(
        saved
          ? state.entries
              .filter(
                (entry) =>
                  !saved.entries.some((ref) => ref.id === entry.id) &&
                  entry.matterId === saved.matterId &&
                  entry.clientId === saved.clientId &&
                  (entry.status === "approved" || entry.status === "confirmed") &&
                  entry.date <= saved.period.to &&
                  (!saved.period.from || entry.date >= saved.period.from),
              )
              .map((entry) => entry.id)
          : [],
      ),
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
  const [chosenHourlyCurrency, setHourlyCurrency] = useState(
    saved?.pricing.mode === "hourly" ? saved.pricing.currency ?? state.invoiceDraft?.currency ?? "" : "",
  );
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
  const preview = useRef<HTMLDivElement>(null);
  const [footerActions, setFooterActions] = useState<HTMLDivElement | null>(null);
  const revealPreview = useRef(false);
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
        to &&
        entry.date <= to &&
        (allOpen || (from && entry.date >= from)),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const draft = state.invoiceDraft;
  const adjustments = state.adjustments ?? [];
  const authorizedRows = rows.map((entry) => {
    const policy = resolveTimePolicy(
      state.policies,
      clientId,
      matterId,
      entry.date,
      entry.projectId,
    );
    const solo = state.scope === "local" && policy.soloApproval;
    const reviewer =
      (policy.reviewerId === state.userId || (solo && !policy.reviewerId)) &&
      (entry.workerId !== state.userId || solo);
    const ownWithoutReviewer = entry.workerId === state.userId && !assignedTimeReviewer(policy, entry.workerId);
    const direct = entry.status === "confirmed" && ownWithoutReviewer;
    const authorized =
      (entry.status === "approved" && (reviewer || ownWithoutReviewer) || direct) &&
      !entry.legacy &&
      entry.billable &&
      entry.clientId === clientId;
    const currentReview = resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId);
    const currentSolo = state.scope === "local" && currentReview.soloApproval;
    const canAssign = entry.status === "confirmed" ? entry.workerId === state.userId :
      (currentReview.reviewerId === state.userId || (currentSolo && !currentReview.reviewerId)) && (entry.workerId !== state.userId || currentSolo);
    return { entry: direct ? { ...entry, ...timeEntryPrice(policy, entry.workerId) } : entry, policy, authorized, canAssign, direct };
  });
  const hourlyCurrencies = [...new Set(authorizedRows.flatMap(({ entry, authorized }) =>
    authorized && isHourlyInvoiceLine(entry) ? [entry.currency] : [],
  ))].sort();
  const hourlyCurrency = hourlyCurrencies.includes(chosenHourlyCurrency) ? chosenHourlyCurrency :
    hourlyCurrencies.length === 1 ? hourlyCurrencies[0] : undefined;
  const currencySupported = state.supportsHourlyInvoiceCurrency === true;
  const legacyCutoffUnavailable = !fixed && allOpen && !currencySupported && Boolean(hourlyCurrency) &&
    authorizedRows.some(({ entry, authorized }) => authorized && (!isHourlyInvoiceLine(entry) || entry.currency !== hourlyCurrency));
  const checks = authorizedRows.map(({ entry, policy, authorized, canAssign, direct }) => {
    const line = adjustedTimeEntry(entry, adjustments);
    const eligible = authorized && (fixed || (isHourlyInvoiceLine(entry) && entry.currency === hourlyCurrency));
    const picked = eligible && (allOpen || !excluded.has(entry.id));
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
    return { entry, line, preparedLine, rules, suggested, edited, accepted, authorized, eligible, picked, canAssign, direct };
  });
  const suggestedWording = checks.flatMap(({ picked, line, suggested, accepted }) =>
    picked && suggested && accepted !== suggested
      ? [[line.id, { type: "suggestion", revision: line.revision, narrative: suggested, currentNarrative: line.narrative }] satisfies [string, NarrativeDecision]]
      : [],
  );
  const included = checks
    .filter(({ picked }) => picked)
    .map(({ entry }) => entry);
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
    period: { from: allOpen ? undefined : from, to },
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
  const visibleDraft =
    draft &&
    JSON.stringify(matchingInput) === JSON.stringify(draft.input) &&
    !legacyCutoffUnavailable &&
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
    setHourlyCurrency("");
    resetSelection();
  }
  function resetSelection() {
    setExcluded(new Set());
    setDecisions(new Map());
    setScopeIds(new Set());
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

  useEffect(() => {
    if (!visibleDraft || !revealPreview.current) return;
    revealPreview.current = false;
    preview.current?.scrollIntoView({ block: "start" });
  }, [visibleDraft?.revision]);

  async function saveDraft() {
    if (visibleDraft) {
      preview.current?.scrollIntoView({ block: "start" });
      return;
    }
    if (!input.success) return;
    revealPreview.current = true;
    setSaving(true);
    try {
      await send({ type: "prepareInvoice", draft: input.data });
    } catch {
      revealPreview.current = false;
    } finally {
      setSaving(false);
    }
  }

  const eligibleRows = checks.filter(row => row.eligible);
  const unavailableRows = checks.filter(row => !row.eligible);
  const amounts = new Map(visibleDraft?.lines.map(line => [line.entry.id, line]));
  return (
    <div className="bo-billing-body bo-invoice-draft">
      <header className="bo-invoice-header">
        <Button size="icon-sm" variant="ghost" onClick={onCancel} disabled={pending} aria-label={t("common.back")} title={t("common.back")}>
          <ArrowLeft size={16} />
        </Button>
        <h2>{t("invoiceReview.create")}</h2>
      </header>
      <div className="bo-invoice-scroll">
      <fieldset disabled={pending}>
        <div className="bo-invoice-settings bo-invoice-parties">
          <label>
            {t("back_office.billing.matter")}
            <TimeRecordPicker label={t("back_office.billing.matter")} placeholder={t("invoiceReview.choose_matter")}
              value={matterId} options={state.matters} disabled={pending} onChange={changeMatter} />
          </label>
          {matter && (soleClient ? (
            <div className="bo-invoice-field">
              <span>{t("back_office.billing.client")}</span>
              <strong className="bo-invoice-client">{soleClient.name}</strong>
            </div>
          ) : (
            <label>
              {t("back_office.billing.client")}
              <TimeRecordPicker label={t("back_office.billing.client")} placeholder={t("invoiceReview.choose_client")}
                value={clientId} options={clients} disabled={pending}
                onChange={value => { setClient(value); setHourlyCurrency(""); resetSelection(); }} />
            </label>
          ))}
        </div>
        {matter && clientId && <>
          <div className="bo-invoice-settings">
            {!allOpen && <label>
              {t("back_office.billing.from")}
              <Input type="date" value={from} onChange={event => setFrom(event.target.value)} />
            </label>}
            <label>
              {t("back_office.billing.to")}
              <Input type="date" value={to} onChange={event => setTo(event.target.value)} />
            </label>
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
            {fixed ? <label>
              {t("invoiceReview.currency")}
              <Input maxLength={3} value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())} />
            </label> : hourlyCurrencies.length > 0 && <label>
              {t("invoiceReview.currency")}
              <TimeSelect label={t("invoiceReview.currency")} placeholder={t("invoiceReview.choose_currency")}
                disabled={pending} value={hourlyCurrency ?? ""} options={hourlyCurrencies.map(id => ({ id, name: id }))}
                onChange={value => { setHourlyCurrency(value); if (reduction === "target") setAdjustmentValue(""); }} />
            </label>}
          </div>
          <div className="bo-invoice-options">
            <label>
              <Checkbox checked={allOpen} disabled={pending} onCheckedChange={checked => { setAllOpen(checked); resetSelection(); }} />
              {t("invoiceReview.all_open")}
            </label>
            {fixed && <label>
              <Checkbox checked={showHours} disabled={pending} onCheckedChange={setShowHours} />
              {t("invoiceReview.show_hours")}
            </label>}
          </div>
          {!fixed && !hourlyCurrency && hourlyCurrencies.length > 1 && (
            <p role="status" className="bo-billing-subrow">{t("invoiceReview.hourly_currency_help")}</p>
          )}
          {legacyCutoffUnavailable && (
            <p role="status" className="bo-billing-subrow">{t("invoiceReview.legacy_currency_cutoff")}</p>
          )}
          {!eligibleRows.length && <p className="bo-billing-notice">{t(rows.length ? "invoiceReview.none_ready" : "invoiceReview.no_entries")}</p>}
          {eligibleRows.length > 0 && <>
            {suggestedWording.length > 0 && <div className="bo-invoice-line-actions">
              <Button size="sm" variant="outline"
                onClick={() => setDecisions(previous => new Map([...previous, ...suggestedWording]))}>
                {t("invoiceReview.apply_suggestions")}
              </Button>
            </div>}
            <table className="bo-invoice-line-table">
              <thead><tr>
                {!allOpen && <th className="bo-invoice-include" scope="col"><span className="sr-only">{t("invoiceReview.include")}</span></th>}
                <th className="bo-invoice-service" scope="col">{t("invoiceReview.service")}</th>
                <th scope="col">{t("invoiceReview.result")}</th>
                {(Boolean(visibleDraft) || !allOpen) && <th className="bo-invoice-amount bo-billing-number" scope="col">
                  {t(visibleDraft ? "invoiceReview.billed" : "invoiceReview.actual_hours")}
                </th>}
              </tr></thead>
              <tbody>
                {eligibleRows.map(({ entry, line, preparedLine, rules, suggested, edited, accepted, picked }) => {
                  const previewLine = amounts.get(entry.id);
                  const original = entry.submittedNarrative ?? entry.narrative;
                  const wording = edited ?? previewLine?.entry.narrative ?? accepted ?? line.narrative;
                  const hasDetails = original !== wording || rules.length > 0 || preparedLine?.modelRule || preparedLine?.guidelineVersions?.length;
                  return <tr key={entry.id}>
                    {!allOpen && <td className="bo-invoice-include">
                      <Checkbox aria-label={t("back_office.billing.select_line", { label: line.narrative })} checked={picked}
                        disabled={pending} onCheckedChange={checked => setExcluded(previous => updateCheck(previous, entry.id, !checked))} />
                    </td>}
                    <td className="bo-invoice-service">
                      <time dateTime={entry.date}>{serviceDate.format(new Date(entry.date + "T00:00:00"))}</time>
                      <small>{people.get(entry.workerId) ?? entry.workerId}</small>
                      {entry.authorId !== entry.workerId && <small>{t("invoiceReview.author", { name: people.get(entry.authorId) ?? entry.authorId })}</small>}
                      {(visibleDraft || allOpen) && <small>{formatInvoiceHours(locale, entry.workedMinutes)} h</small>}
                    </td>
                    <td>
                      {picked ? <Textarea maxLength={2000} className="min-h-9 py-1.5"
                        aria-label={t("invoiceReview.edit_wording", { label: line.narrative })} value={wording}
                        onChange={event => changeWording(entry.id, { type: "edit", revision: entry.revision, narrative: event.target.value })} />
                        : <p className="bo-invoice-unselected">{wording}</p>}
                      {suggested && suggested !== wording && picked && <div className="bo-invoice-wording-suggestion">
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
                      {(edited !== undefined || accepted !== undefined) && picked && <Button size="xs" variant="ghost"
                        onClick={() => changeWording(entry.id, undefined)}>{t("invoiceReview.reset_wording")}</Button>}
                    </td>
                    {(visibleDraft || !allOpen) && <td className="bo-invoice-amount bo-billing-number">
                      {visibleDraft ? previewLine && <>
                        {money(previewLine.amountMinor, visibleDraft.currency)}
                        {previewLine.baseAmountMinor !== previewLine.amountMinor && <small title={t("invoiceReview.base_amount")}>
                          <s>{money(previewLine.baseAmountMinor, visibleDraft.currency)}</s>
                        </small>}
                      </> : formatInvoiceHours(locale, entry.workedMinutes)}
                    </td>}
                  </tr>;
                })}
              </tbody>
            </table>
          </>}
          {unavailableRows.length > 0 && <details className="bo-invoice-unavailable">
            <summary><ChevronRight size={15} />{t("invoiceReview.excluded_entries", { count: unavailableRows.length })}</summary>
            <ul>{unavailableRows.map(({ entry, policy, authorized, canAssign, direct }) => <li key={entry.id}>
              <div>{entry.narrative}<small>{serviceDate.format(new Date(entry.date + "T00:00:00"))} · {people.get(entry.workerId) ?? entry.workerId}</small></div>
              <div>
                {t(entryStatusKeys[entry.status])}
                {state.supportsBillingClientAssignment && entry.billable && !entry.clientId && canAssign ? (
                  <Button size="xs" variant="outline" disabled={pending}
                    onClick={() => void send({ type: "assignBillingClient", id: entry.id, revision: entry.revision, clientId }).catch(() => {})}>
                    {t("invoiceReview.assign_recipient", { client: currentClient?.name ?? "" })}
                  </Button>
                ) : entry.status === "submitted" ? (
                  <Button size="xs" variant="outline" onClick={() => onReviewSubmitted(entry)}>{t("invoiceReview.review_open")}</Button>
                ) : entry.status === "confirmed" && !direct ? (
                  <small>{entry.workerId === state.userId ? <Link className="bo-invoice-link" state={{ timeWorkspaceTab: "entries" }}
                    to={timeRoutes.timesheets + "?date=" + entry.date}>{t("invoiceReview.submit_open")}</Link> : t("invoiceReview.await_submission")}</small>
                ) : <small>{!fixed && authorized ? (
                  isHourlyInvoiceLine(entry) ? t("invoiceReview.open_currency_line", { currency: entry.currency })
                    : t(entry.nonHourlyApproval || policy.nonHourlyAgreement ? "back_office.billing.non_hourly" : "back_office.billing.price_missing")
                ) : t("invoiceReview.unavailable_line")}</small>}
              </div>
            </li>)}</ul>
          </details>}
          {eligibleRows.length > 0 && <div className="bo-invoice-reduction">
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
          </div>}
        </>}
      </fieldset>
      {visibleDraft && (
        <div className="bo-invoice-draft-preview" ref={preview}>
          <div className="bo-billing-subrow">
            <strong>
              {t("invoiceReview.total", {
                amount: money(visibleDraft.totalMinor, visibleDraft.currency),
              })}
            </strong>
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
              {t("invoiceReview.template_version", {
                revision: visibleDraft.snapshot.template.revision,
              })}
            </span>
          </div>
          {state.supportsInvoiceWordingReview &&
            models.length > 0 &&
            !visibleDraft.approval && (
              <div className="bo-billing-subrow">
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
          >
            {pdfReady => footerActions && createPortal(
              visibleDraft.approval ? <Button size="sm" disabled={pending || !pdfReady}
                onClick={() => void issue(visibleDraft)}>{t("back_office.billing.issue")}</Button>
                : <Button size="sm" disabled={pending || !pdfReady || !visibleDraft.snapshot.clientAddress}
                  onClick={() => void send({ type: "approveInvoice", id: visibleDraft.id, revision: visibleDraft.revision }).catch(() => {})}>
                  {t("invoiceReview.approve")}
                </Button>, footerActions)}
          </BillingInvoicePdf>
        </div>
      )}
      </div>
      <footer className="bo-invoice-footer">
        <div className="bo-invoice-save-status">
          {error ? <p role="alert" className="bo-billing-error">{error}</p> :
            pendingAdjustments ? <p role="status">{t("back_office.billing.invoice_correction_pending")}</p> :
            visibleDraft ? <p role="status"><Check size={14} />{t(visibleDraft.approval ? "invoiceReview.approved" : "invoiceReview.saved")}
              {!visibleDraft.snapshot.clientAddress && <span>{t("invoiceReview.address_required")}</span>}</p> :
            included.length > 0 && <p>{t("invoiceReview.selected_entries", { count: included.length })}</p>}
        </div>
        <div className="bo-invoice-footer-actions">
          <Button size="sm" variant={visibleDraft ? "outline" : "default"}
            disabled={!input.success || pending || pendingAdjustments || legacyCutoffUnavailable} onClick={() => void saveDraft()}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t(visibleDraft ? "back_office.billing.preview" : "invoiceReview.save_preview")}
          </Button>
          <div ref={setFooterActions} />
        </div>
      </footer>
    </div>
  );
}
