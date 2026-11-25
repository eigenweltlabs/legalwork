import { useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration } from "./time-duration";
import { TimeRecordPicker, TimeSelect } from "./time-settings-controls";
import { currencyScale } from "@legalwork/types/invoice-template";
import {
  InvoiceDraftInputSchema,
  adjustedTimeEntry,
  appliesTimeAdjustment,
  hasTimeEntryPrice,
  isHourlyInvoiceLine,
  resolveTimePolicy,
  timeEntryPrice,
  type TimeEntry,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  useBillingAction,
  type BillingProps,
} from "./billing-components";
import { BillingPreferences } from "./billing-preferences";
import { formatFee } from "./billing-amounts";
import { entryStatusKeys } from "./timesheet-labels";
import { invoiceEntryAccess } from "./invoice-entry-access";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Surface } from "../../design-system/surface";
import { timeRoutes } from "./time-routes";

type DraftProps = BillingProps & {
  initialMatterId: string;
  initialClientId: string;
  initialEntry?: TimeEntry;
  dates?: { from: string; to: string };
  onCancel: () => void;
  onReviewSubmitted: (entry: TimeEntry) => void;
  onIssued: () => void;
};

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
  dates,
  initialMatterId, initialClientId, initialEntry,
  onCancel,
  onReviewSubmitted,
  onIssued,
}: DraftProps) {
  const locale = useLocale();
  const [rateEntry, setRateEntry] = useState<TimeEntry>();
  const savingRate = useRef(false);
  const matterInputId = useId();
  const clientInputId = useId();
  const durationFormat = useTimeDurationFormat();
  const [from, setFrom] = useState(dates?.from ?? "");
  const [to, setTo] = useState(dates?.to ?? "");
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
  const [matterId, setMatter] = useState(() => initialMatterId || (withWork.length === 1 ? withWork[0].id : ""));
  const matter = state.matters.find(item => item.id === matterId);
  const clients = state.clients.filter(item => matter?.clientIds.includes(item.id));
  const [chosenClient, setClient] = useState(initialClientId);
  const soleClient = matter?.clientIds.length === 1 && clients.length === 1 ? clients[0] : undefined;
  const clientId = soleClient?.id ?? (clients.some(item => item.id === chosenClient) ? chosenClient : "");
  const [selected, setSelected] = useState(() => new Set(initialEntry ? [initialEntry.id] : []));
  const [fixed, setFixed] = useState(false);
  const [currency, setCurrency] = useState("");
  const [fixedPrice, setFixedPrice] = useState("");
  const [reduction, setReduction] = useState<"" | "percent" | "target">("");
  const [scope, setScope] = useState<"all" | "people" | "entries">("all");
  const [scopeIds, setScopeIds] = useState(new Set<string>());
  const [targetBasis, setTargetBasis] = useState<"selection" | "invoice">("selection");
  const [adjustmentValue, setAdjustmentValue] = useState("");
  const { send, error, pending } = useBillingAction(onCommand);
  const [pricingOpen, setPricingOpen] = useState(false);
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
  const checks = authorizedRows.map(({ entry, authorized, canAssign, direct }) => ({
    entry, authorized, canAssign, direct,
    line: adjustedTimeEntry(entry, adjustments),
    picked: authorized && selected.has(entry.id),
  }));
  const included = checks.filter(({ picked }) => picked).map(({ entry }) => entry);
  const missingRate = included.some(entry => !isHourlyInvoiceLine(entry));
  const mixedCurrencies = hourlyCurrencies.length > 1;
  const hourlyPricingMissing = !fixed && (missingRate || mixedCurrencies);
  const selectedTerms = authorizedRows.filter(({ entry, authorized }) => authorized && selected.has(entry.id));
  const agreementBlock = selectedTerms.some(({ policy }) => policy.ambiguousAgreement)
    ? "invoiceReview.ambiguous_agreement"
    : selectedTerms.some(({ entry, policy }) => entry.nonHourlyBasis === "tariff" || policy.nonHourlyBasis === "tariff")
      ? "invoiceReview.tariff_agreement"
      : !fixed && selectedTerms.some(({ entry, policy }) => entry.nonHourlyApproval || policy.nonHourlyAgreement)
        ? "invoiceReview.fixed_agreement_help"
        : undefined;
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
  const input = InvoiceDraftInputSchema.safeParse({
    matterId,
    clientId,
    period: { from: from || included[0]?.date, to: to || included.at(-1)?.date },
    entries: included.map(({ id, revision }) => ({ id, revision })),
    adjustmentVersions: approvedAdjustments.map(({ id, revision }) => ({
      id,
      revision,
    })),
    wording: [],
    pricing: fixed
      ? {
          mode: "fixed",
          currency,
          amountMinor: minorUnits(fixedPrice, scale),
          showHours: false,
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
  function changeMatter(id: string) {
    setMatter(id);
    setClient("");
    resetSelection();
  }
  function resetSelection() {
    setSelected(new Set());
    setFixed(false);
    setCurrency("");
    setFixedPrice("");
    setReduction("");
    setScopeIds(new Set());
    setAdjustmentValue("");
    setPricingOpen(false);
  }
  function changeFeeBasis(value: string) {
    setFixed(value === "fixed");
    if (!currency) setCurrency(hourlyCurrency ?? included.find(entry => entry.currency)?.currency ?? "EUR");
  }
  const canSave = input.success && !hourlyPricingMissing && !agreementBlock && !invalidDates &&
    !pending && !pendingAdjustments;
  async function createInvoice() {
    if (!canSave || !input.success) return;
    const revision = JSON.stringify(input.data);
    if (request.current?.revision !== revision)
      request.current = { revision, id: crypto.randomUUID() };
    try {
      await send({ type: "createInvoice", invoice: input.data, requestId: request.current.id });
      onIssued();
    } catch {
      // Keep the selection so it can be retried.
    }
  }

  const selectableRows = checks.filter(row => row.authorized);
  const unavailableRows = checks.filter(row => !row.authorized && row.entry.billable);
  const rateGroups = new Map(included.map(entry =>
    [JSON.stringify([entry.workerId, entry.date, entry.projectId, entry.hourlyRate, entry.currency, entry.nonHourlyApproval]), entry]));
  return (
    <div className="bo-billing-body bo-invoice-draft">
      <header className="bo-invoice-header">
        <Button size="icon-sm" variant="ghost" onClick={onCancel} disabled={pending} aria-label={t("common.back")} title={t("common.back")}>
          <ArrowLeft size={16} />
        </Button>
        <h2>{t("invoiceReview.create")}</h2>
      </header>
      <div className="bo-invoice-scroll">
      <fieldset disabled={pending} className="bo-invoice-content">
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
              <h3 className="text-base font-semibold">{t("timeWorkspace.entries")}</h3>
              <CollapsibleTrigger className="group" render={<Button variant={from || to ? "outline" : "ghost"} size="sm" />}>
                {t("invoiceReview.filter_dates")}<ChevronRight className="group-aria-expanded:rotate-90" />
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="bo-invoice-settings px-0 pt-3">
              <label>{t("back_office.billing.from")}
                <Input type="date" value={from} onChange={event => { setFrom(event.target.value); }} />
              </label>
              <label>{t("back_office.billing.to")}
                <Input type="date" value={to} onChange={event => { setTo(event.target.value); }} />
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
        {included.length > 0 && <>
          <details className="bo-invoice-disclosure" open={pricingOpen || hourlyPricingMissing || !!agreementBlock}
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
                  onChange={changeFeeBasis} />
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
            {agreementBlock && <div className="bo-invoice-rates">
              <p role="status" className="text-sm">{t(agreementBlock)}</p>
              {agreementBlock === "invoiceReview.fixed_agreement_help" && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => changeFeeBasis("fixed")}>
                  {t("invoiceReview.use_fixed_price")}
                </Button>
              )}
            </div>}
            {!fixed && !agreementBlock && rateGroups.size > 0 && <div className="bo-invoice-rates">
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
        </>}
      </fieldset>
      </div>
      <footer className="bo-invoice-footer">
        <div className="bo-invoice-save-status">
          {error ? <p role="alert" className="bo-billing-error">{error}</p> :
            pendingAdjustments ? <p role="status">{t("back_office.billing.invoice_correction_pending")}</p> :
            agreementBlock ? <p role="status">{t("invoiceReview.check_terms")}</p> :
            hourlyPricingMissing ? <p role="status">{t(mixedCurrencies ? "invoiceReview.mixed_rates_short" : "invoiceReview.rate_required")}</p> :
            included.length ? <p>{t("invoiceReview.selected_entries", { count: included.length })}
              {!input.success && !hourlyPricingMissing && <span>{t("invoiceReview.check_terms")}</span>}</p> :
            <p>{t("invoiceReview.choose_entry")}</p>}
        </div>
        <div className="bo-invoice-footer-actions">
          <Button size="sm" disabled={!canSave} onClick={() => void createInvoice()}>
            {pending && <Loader2 size={14} className="animate-spin" />}
            {t("invoiceReview.create")}
          </Button>
        </div>
      </footer>
      {rateEntry && <Dialog open onOpenChange={open => { if (!open && !savingRate.current) setRateEntry(undefined); }}>
        <DialogContent showCloseButton={false} className="max-h-[85dvh] flex flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("invoiceReview.timekeeper_rates")}</DialogTitle>
            <p className="text-sm">{state.projects.find(project => project.id === rateEntry.projectId)?.name ?? matter?.name}
              {" · "}{serviceDate.format(new Date(rateEntry.date + "T00:00:00"))}</p>
            <DialogDescription>{t(rateEntry.status === "approved" ? "invoiceReview.approved_rate_help" : "invoiceReview.policy_rate_help")}</DialogDescription>
          </DialogHeader>
          <BillingPreferences state={state} section="rates" onCommand={async command => {
            savingRate.current = true;
            try {
              return await onCommand(command);
            } finally {
              savingRate.current = false;
            }
          }}
            initialProjectId={rateEntry.projectId} initialMatterId={matterId} initialClientId={clientId}
            initialDate={rateEntry.date} invoiceRateEditor={{
              workerId: rateEntry.workerId,
              onClose: () => setRateEntry(undefined),
              validate: rateEntry.status === "approved" ? undefined : policy => {
                const policies = state.policies.filter(existing => existing.scope !== policy.scope ||
                  existing.targetId !== policy.targetId || existing.effectiveFrom !== policy.effectiveFrom);
                const resolved = resolveTimePolicy([...policies, { ...policy, revision: policy.revision + 1 }],
                  clientId, matterId, rateEntry.date, rateEntry.projectId);
                if (!hasTimeEntryPrice(timeEntryPrice(resolved, rateEntry.workerId))) return t("invoiceReview.rate_required");
              },
            }} />
        </DialogContent>
      </Dialog>}
    </div>
  );
}
