import { entryStatusKeys, historyActionKeys, historyFieldKeys, labelForCode, reviewViewKeys } from "./timesheet-labels";
import { formatInvoiceMinor } from "@legalwork/types/invoice-template";
import { Link, useNavigate } from "react-router-dom";
import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { HubTabs } from "../settings/segmented-tabs";
import { invoiceEntryAccess } from "./invoice-entry-access";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TimeSelect } from "./time-settings-controls";
import { timeRoutes } from "./time-routes";
import { ChevronDown, ChevronRight, History, Plus, SlidersHorizontal } from "lucide-react";
import {
  type TimeEntry,
  type TimesheetState,
  adjustedTimeEntry,
  appliesTimeAdjustment,
  hasTimeEntryPrice,
  resolveTimePolicy,
  timeEntryPrice,
  timePolicyError,
  timeCapWarning,
} from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { WorkdayModelOption } from "@legalwork/types/time-capture";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { BillingInvoiceDraft } from "./billing-invoice-draft";
import { saveInvoiceDownload } from "./billing-invoice-pdf";
import { BillingWordingCheck } from "./billing-wording-check";
import { BillingEditCell } from "./billing-edit-cell";
import { BillingAdjustments } from "./billing-adjustments";
import { BillingCosts } from "./billing-costs";
import { feeSummary, useBillingAction, type BillingProps } from "./billing-components";
import { reviewPeriod } from "./billing-amounts";
import "./billing-review.css";

type Mode = "submitted" | "approved" | "invoices" | "costs" | "adjustments";
function policyFor(state: TimesheetState, e: TimeEntry) {
  return resolveTimePolicy(state.policies, e.clientId, e.matterId, e.date, e.projectId);
}
function eligible(
  state: TimesheetState,
  entry: TimeEntry,
  p: ReturnType<typeof resolveTimePolicy>,
  canEdit: boolean,
) {
  const solo = state.scope === "local" && p.soloApproval;
  return (
    state.canReview &&
    canEdit &&
    (p.reviewerId === state.userId || (solo && !p.reviewerId)) &&
    (entry.workerId !== state.userId || solo)
  );
}
const refs = (entries: TimeEntry[]) => entries.map(({ id, revision }) => ({ id, revision }));

function BillingHistory({ e, state }: { e: TimeEntry; state: TimesheetState }) {
  const locale = useLocale();
  return (
    <details>
      <summary>{t("back_office.billing.history")}</summary>
      {e.source === "suggestion" && (
        <p>
          <strong>{t("timesheets.ledger.original")}</strong>{" · "}
          {e.sharedOriginal
            ? <>{e.sharedOriginal.activity} · {e.sharedOriginal.narrative} · {
                e.sharedOriginal.workedMinutes === null
                  ? t("timesheets.ledger.unknown_minutes")
                  : e.sharedOriginal.workedMinutes + " min"
              } · {t("back_office.billing.version", { n: e.sharedOriginal.submittedRevision })}</>
            : t("timesheets.ledger.original_private")}
        </p>
      )}
      <ol className="bo-billing-history">
        {e.history.map((h) => (
          <li key={h.revision}>
            <small>
              {new Date(h.at).toLocaleString(locale)} ·{" "}
              {state.people.find((p) => p.id === h.actorId)?.name || h.actorId} ·{" "}
              {t("back_office.billing.version", { n: h.revision })} · {labelForCode(historyActionKeys, h.action)}
            </small>
            <div>
              {h.before && h.before.narrative !== h.after.narrative && (
                <del>{h.before.narrative} → </del>
              )}
              {h.after.narrative}
            </div>
            <small>
              {(["activity", "workedMinutes", "billableMinutes"] as const).map((field, index) => (
                <Fragment key={field}>
                  {index > 0 && " · "}{labelForCode(historyFieldKeys, field)}{" "}
                  {h.before && h.before[field] !== h.after[field] && <del>{h.before[field]} → </del>}
                  {h.after[field]}
                </Fragment>
              ))}
            </small>
            {h.reason && <div>{h.reason}</div>}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function BillingReview({
  state,
  onCommand,
  client,
  canEdit,
  initialDate,
  initialMatterId = "",
  workdayModels,
  initialMode = "submitted",
  invoiceViews = false, renderRecordHistory, invoiceRegister, documentClient,
}: BillingProps & {
  canEdit: boolean;
  initialDate?: string;
  initialMatterId?: string;
  workdayModels?: WorkdayModelOption[];
  initialMode?: "submitted" | "invoices";
  invoiceViews?: boolean;
  invoiceRegister?: ReactNode;
  documentClient?: LegalworkServerClient;
  renderRecordHistory?: (entry: TimeEntry, close: () => void) => ReactNode;
  client: Pick<LegalworkServerClient, "downloadTimesheetAdjustment" | "downloadTimesheetDraft">;
}) {
  const locale = useLocale();
  const navigate = useNavigate();
  const views: readonly Mode[] = invoiceViews ? ["invoices", "approved"] : ["submitted", "approved", "adjustments", "invoices", "costs"];
  const [mode, setMode] = useState<Mode>(initialMode);
  const [dates, setDates] = useState(() =>
    reviewPeriod(initialDate ? new Date(initialDate + "T12:00:00") : new Date()),
  );
  const [allUnbilled, setAllUnbilled] = useState(false);
  const unbilledView = invoiceViews && mode === "approved";
  const throughEndDate = mode === "approved" && allUnbilled;
  const [matter, setMatter] = useState(initialMatterId);
  const [billTo, setBillTo] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [revisionPick, setRevisionPick] = useState(new Map<string, number>());
  const [detail, setDetail] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(Boolean(initialMatterId));
  const [invoiceEntry, setInvoiceEntry] = useState<TimeEntry>();
  const [historyId, setHistoryId] = useState("");
  const [reason, setReason] = useState("");
  const [draftCells, setDraftCells] = useState(new Set<string>());
  const editCell = useCallback((key: string, active: boolean) => {
    setDraftCells((previous) => {
      const next = new Set(previous);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [invoiceScreen, setInvoiceScreen] = useState<"closed" | "invoice" | "review">("closed");
  const [downloadError, setDownloadError] = useState("");
  const { send, error, pending } = useBillingAction(onCommand);
  const groups = useMemo(
    () => ({
      matters: new Map(state.matters.map((r) => [r.id, r.name])),
      people: new Map(state.people.map((r) => [r.id, r.name])),
      clients: new Map(state.clients.map((r) => [r.id, r.name])),
    }),
    [state.matters, state.people, state.clients],
  );
  const all = state.entries.filter(
    (e) =>
      (throughEndDate || !dates.from || dates.from <= e.date) &&
      (!throughEndDate || (e.billable && (unbilledView || !e.legacy))) &&
      (!dates.to || e.date <= dates.to) &&
      (!matter || matter === e.matterId) &&
      (!billTo || billTo === e.clientId || (!e.clientId && state.matters.some(m => m.id === e.matterId && m.clientIds.includes(billTo)))),
  );
  const reviewInfo = useMemo(
    () =>
      new Map(
        state.entries.map((entry) => {
          const policy = policyFor(state, entry);
          const price = timeEntryPrice(policy, entry.workerId);
          return [
            entry.id,
            {
              policy,
              overCap: Boolean(timeCapWarning(entry, policy)),
              error: timePolicyError(entry, policy),
              priceIssue: entry.billable && !policy.nonHourlyAgreement
                ? !hasTimeEntryPrice(price)
                  ? "back_office.billing.price_missing"
                  : entry.hourlyRate !== price.hourlyRate || entry.currency !== price.currency
                    ? "back_office.billing.price_changed"
                    : undefined
                : undefined,
              eligible: eligible(state, entry, policy, canEdit),
            },
          ] as const;
        }),
      ),
    [state.entries, state.policies, state.userId, state.canReview, canEdit, state.scope],
  );
  const issues = (e: TimeEntry) => e.suggestion || reviewInfo.get(e.id)?.error || reviewInfo.get(e.id)?.priceIssue;
  const rows = all
    .filter((e) => (unbilledView ? e.billable && ["confirmed", "approved", "submitted"].includes(e.status) : e.status === mode) && (mode !== "submitted" || !onlyIssues || issues(e)))
    .sort((a, b) => {
      const priority =
        mode === "submitted"
          ? Number(reviewInfo.get(b.id)?.overCap) - Number(reviewInfo.get(a.id)?.overCap)
          : 0;
      return priority || a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    });
  const eligibleRows = rows.filter((e) =>
    mode === "approved" ? state.canReview && canEdit && (!unbilledView ||
      (e.status === "approved" && !e.legacy && !hasTimeEntryPrice(e) && !e.nonHourlyApproval &&
        reviewInfo.get(e.id)?.eligible && !reviewInfo.get(e.id)?.policy.nonHourlyAgreement)) : reviewInfo.get(e.id)?.eligible,
  );
  const showSelection = !unbilledView || eligibleRows.length > 0;
  const selected = eligibleRows.filter((e) => revisionPick.get(e.id) === e.revision);
  const adjustments = state.adjustments ?? [];
  const effective = (line: TimeEntry) =>
    mode === "approved" ? adjustedTimeEntry(line, adjustments) : line;
  const pricedEntry = (entry: TimeEntry) => {
    const line = effective(entry);
    return entry.status === "confirmed" && invoiceEntryAccess(state, entry).direct
      ? { ...line, ...timeEntryPrice(policyFor(state, entry), entry.workerId) } : line;
  };
  const linkedAdjustments = adjustments.filter((a) => selected.some((line) => appliesTimeAdjustment(line, a)));
  const hasPendingCorrections = linkedAdjustments.some((a) => a.status === "pending");
  const canReturnUnpriced = mode === "approved" && selected.length > 0 && selected.every((e) =>
    e.billable && !e.legacy && !e.nonHourlyApproval && !hasTimeEntryPrice(e) && reviewInfo.get(e.id)?.eligible &&
    !reviewInfo.get(e.id)?.policy.nonHourlyAgreement,
  );
  const issuesCount = all.filter((e) => e.status === "submitted" && issues(e)).length;
  const pick = (e: TimeEntry, checked: boolean) => {
    setRevisionPick((prev) => {
      const next = new Map(prev);
      if (checked) next.set(e.id, e.revision);
      else next.delete(e.id);
      return next;
    });
  };
  const reset = () => {
    setRevisionPick(new Map());
    setDetail("");
    setReason("");
    setHistoryId("");
    setDownloadError("");
  };
  function returnSelection() {
    void send({ type: "return", entries: refs(selected), reason: reason.trim() || undefined }).then(reset).catch(() => {});
  }
  async function downloadAdjustment(id: string) {
    setDownloadError("");
    try {
      const file = await client.downloadTimesheetAdjustment(id, state.scope);
      saveInvoiceDownload(file, "Adjustment-" + id + ".html");
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t("back_office.billing.download_failed"));
    }
  }
  const supportsCreation = state.supportsInvoiceCreation || state.supportsInvoiceDrafts;
  const canCreate = (state.canInvoice ?? state.canReview) && canEdit && supportsCreation === true;
  const historyEntry = rows.find(entry => entry.id === historyId);
  const draftMatter = invoiceEntry?.matterId || matter;
  const draftClient = invoiceEntry?.clientId || billTo;
  const resume = !invoiceEntry && (invoiceScreen === "review" || (state.invoiceDraft &&
    (!matter || state.invoiceDraft.input.matterId === matter) && (!billTo || state.invoiceDraft.input.clientId === billTo)));
  const invoiceEditing = invoiceScreen !== "closed" && canCreate;
  const invoiceVisible = invoiceScreen === "invoice" && canCreate;
  return (
    <>
      {invoiceEditing && (
        <div className="bo-invoice-editor-view" hidden={!invoiceVisible}>
          <section className="bo-billing">
            <BillingInvoiceDraft
              state={state} onCommand={onCommand} client={client} documentClient={documentClient}
              dates={filtersOpen ? { from: throughEndDate ? "" : dates.from, to: dates.to } : undefined}
              initialEntry={invoiceEntry} initialMatterId={draftMatter} initialClientId={draftClient} workdayModels={workdayModels}
              onCancel={() => { setInvoiceEntry(undefined); setInvoiceScreen("closed"); }}
              onReviewSubmitted={(entry) => {
                if (invoiceViews) {
                  setInvoiceScreen("review");
                  navigate(timeRoutes["billing-review"] + "?" + new URLSearchParams({ date: entry.date }));
                  return;
                }
                reset();
                setDates({ from: entry.date, to: entry.date });
                setMatter(entry.matterId ?? "");
                setBillTo(entry.clientId ?? "");
                setOnlyIssues(false);
                setDetail(entry.id);
                setMode("submitted");
                setInvoiceScreen("review");
              }}
              onIssued={() => { setInvoiceEntry(undefined); reset(); setDates({ from: "", to: "" }); setInvoiceScreen("closed"); setMode("invoices"); }}
            />
          </section>
        </div>
      )}
      {!invoiceVisible && (
      <section className="bo-billing @container/time-history relative isolate">
      <header className="bo-billing-topbar">
        {invoiceViews ? <HubTabs label={t("back_office.billing.view")} value={mode}
          items={[{ id: "invoices", label: t(invoiceRegister ? "invoiceReview.all_invoices" : "back_office.billing.view_invoices") }, { id: "approved", label: t("invoiceReview.unbilled_time") }]}
          onChange={next => { setMode(next); reset(); }} /> :
          <TimeSelect label={t("back_office.billing.view")} value={mode}
            options={views.map(id => ({ id, name: t(reviewViewKeys[id]) }))}
            onChange={value => { const next = views.find(view => view === value); if (next) { setMode(next); reset(); } }} />}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {invoiceViews && !(invoiceRegister && mode === "invoices") && <Button size="sm" variant="ghost" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
            <SlidersHorizontal />{t("invoiceReview.filters")}</Button>}
          {invoiceViews && mode === "invoices" && <Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/back-office/invoices">
            {t("timesheets.invoice_record_add")}</Link>}
          {["approved", "invoices", "submitted"].includes(mode) && supportsCreation && <Button size="sm"
            disabled={!canCreate} onClick={() => { setInvoiceEntry(undefined); setInvoiceScreen("invoice"); }}>
            <Plus />{t(resume ? "invoiceReview.resume" : "invoiceReview.create")}
          </Button>}
        </div>
      </header>
      {["approved", "invoices", "submitted"].includes(mode) && !canCreate && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">
        {t(!supportsCreation ? "invoiceReview.firm_unavailable" : !canEdit ? "invoiceReview.read_only" : "invoiceReview.no_invoice_access")}
      </p>}
      {(!invoiceViews || filtersOpen) && !(invoiceRegister && mode === "invoices") && <div className="bo-view-toolbar bo-invoice-index-toolbar">
        <label>
          {t("back_office.billing.from")}
          <Input type="date" disabled={throughEndDate} value={throughEndDate ? "" : dates.from}
            onChange={event => { setDates({ ...dates, from: event.target.value }); reset(); }} />
        </label>
        <label>
          {t("back_office.billing.to")}
          <Input type="date" value={dates.to}
            onChange={event => { setDates({ ...dates, to: event.target.value }); reset(); }} />
        </label>
        {mode === "approved" && <label>
          <Checkbox checked={allUnbilled} onCheckedChange={checked => { setAllUnbilled(checked); reset(); }} />
          {t("back_office.billing.all_unbilled")}
        </label>}
        <TimeSelect label={t("back_office.billing.client")} value={billTo}
          options={[{ id: "", name: t("back_office.billing.all_clients") }, ...state.clients]}
          onChange={value => { setBillTo(value); setMatter(""); reset(); }} />
        <TimeSelect label={t("back_office.billing.matter")} value={matter}
          options={[{ id: "", name: t("back_office.billing.all_matters") }, ...state.matters.filter(item => !billTo || item.clientIds.includes(billTo))]}
          onChange={value => { setMatter(value); reset(); }} />
        {(matter || billTo) && (
          <Link className="bo-time-secondary" to={"/settings/billing?" + new URLSearchParams({
            ...(matter ? { matter } : { client: billTo }),
            date: dates.from || reviewPeriod().to,
          })}>{t("timesheets.review_rules")}</Link>
        )}
        {mode === "submitted" && (
          <label>
            <Checkbox checked={onlyIssues} onCheckedChange={checked => { setOnlyIssues(checked); reset(); }} />
            {t("back_office.billing.only_issues", { count: issuesCount })}
          </label>
        )}
      </div>}
      {mode === "adjustments" ? (
        <BillingAdjustments
          rows={all}
          canEdit={canEdit}
          state={state}
          onCommand={onCommand}
          download={downloadAdjustment}
        />
      ) : mode === "costs" ? (
        <BillingCosts rows={all} state={state} onCommand={onCommand} />
      ) : mode === "invoices" ? (invoiceRegister ?? (
        <Empty variant="ghost"><EmptyHeader><EmptyTitle>{t("back_office.billing.no_invoices")}</EmptyTitle></EmptyHeader></Empty>
      )) : (
        <>
          <div className="bo-billing-body">
            <Table>
              <TableHeader>
                <TableRow>
                  {showSelection && <TableHead className="w-10">
                    <Checkbox aria-label={t("back_office.billing.select_all")} disabled={pending || !eligibleRows.length}
                      checked={eligibleRows.length > 0 && eligibleRows.length === selected.length}
                      indeterminate={selected.length > 0 && selected.length < eligibleRows.length}
                      onCheckedChange={checked => setRevisionPick(checked
                        ? new Map(eligibleRows.map(row => [row.id, row.revision])) : new Map())} />
                  </TableHead>}
                  <TableHead>{t("native.description")}</TableHead>
                  <TableHead className="bo-billing-number">{t("back_office.billing.charge")}</TableHead>
                  <TableHead className="bo-billing-number">{t("back_office.billing.fees")}</TableHead>
                  <TableHead><span className="sr-only">{t("back_office.billing.details")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => {
                  const info = reviewInfo.get(e.id)!;
                  const canEditLine = info.eligible && mode === "submitted",
                    open = detail === e.id,
                    detailLabel = e.suggestion
                      ? t("back_office.billing.suggestion")
                      : t("back_office.billing.details");
                  const currentPolicy = info.policy;
                  const limit = currentPolicy.activityLimits[e.activity] ?? currentPolicy.maxMinutes;
                  const overCap = mode === "submitted" && info.overCap;
                  const policyError = mode === "submitted" ? info.error : "";
                  const priceIssue = mode === "submitted" ? info.priceIssue : undefined;
                  const unpriced = e.status === "approved" && mode === "approved" && e.billable && !e.legacy && !hasTimeEntryPrice(e);
                  const priceNotice = unpriced
                    ? e.nonHourlyApproval || currentPolicy.nonHourlyAgreement
                      ? "back_office.billing.non_hourly"
                      : "back_office.billing.price_return_help"
                    : priceIssue;
                  const access = invoiceEntryAccess(state, e);
                  const invoiceable = canCreate && access.authorized;
                  const billedLine = effective(e);
                  const pricedLine = pricedEntry(e);
                  const openEntry = () => { setInvoiceEntry(e); setInvoiceScreen("invoice"); };
                  return (
                    <Fragment key={e.id}>
                      <TableRow>
                        {showSelection && <TableCell>
                          <Checkbox aria-label={t("back_office.billing.select_line", { label: e.narrative })}
                            checked={revisionPick.get(e.id) === e.revision}
                            disabled={pending || !eligibleRows.includes(e)} onCheckedChange={checked => pick(e, checked)} />
                        </TableCell>}
                        <TableCell className="bo-billing-description">
                          <BillingEditCell
                            cellId={e.id + "/text"}
                            revision={e.revision}
                            onEditing={editCell}
                            label={t("back_office.billing.narrative")}
                            value={effective(e).narrative}
                            disabled={!canEditLine}
                            onSave={(narrative) =>
                              send({
                                type: "review",
                                id: e.id,
                                revision: e.revision,
                                narrative,
                                billableMinutes: e.billableMinutes,
                              }).then(() => undefined)
                            }
                          />
                          <small>{groups.matters.get(e.matterId) || e.matterId} · {groups.people.get(e.workerId) || e.workerId} · {new Date(e.date + "T12:00:00").toLocaleDateString(locale)}</small>
                        </TableCell>
                        <TableCell className="bo-billing-number">
                          <BillingEditCell
                            cellId={e.id + "/minutes"}
                            revision={e.revision}
                            onEditing={editCell}
                            label={t("back_office.billing.charge")}
                            numeric
                            value={String(effective(e).billableMinutes)}
                            disabled={!canEditLine}
                            showReason
                            onSave={(next, reason) =>
                              send({
                                type: "review",
                                id: e.id,
                                revision: e.revision,
                                billableMinutes: Number(next),
                                narrative: e.narrative,
                                reason,
                              }).then(() => undefined)
                            }
                          />
                        </TableCell>
                        <TableCell className="bo-billing-number">{!e.billable ? t("timesheets.ledger.nonbillable") :
                          e.nonHourlyApproval || access.policy.nonHourlyAgreement ? t("invoiceReview.fixed_agreement") :
                          hasTimeEntryPrice(pricedLine) ? feeSummary([pricedLine]) : t("invoiceReview.no_rate")}</TableCell>
                        <TableCell>
                          <div className="bo-billing-entry-actions">
                          {invoiceable && mode === "approved" && <Button size="sm" variant="outline" onClick={openEntry}>
                            {t("invoiceReview.invoice_entry")}</Button>}
                          <Button size="sm" variant="ghost"
                            aria-label={
                              overCap
                                ? t("back_office.billing.over_cap", {
                                    minutes: e.billableMinutes - limit,
                                  })
                                : priceNotice
                                  ? t("back_office.billing.pricing")
                                  : detailLabel
                            }
                            aria-expanded={open}
                            className={overCap ? "bo-billing-cap" : undefined}
                            onClick={() => setDetail(open ? "" : e.id)}
                          >
                            {overCap
                              ? t("back_office.billing.over_cap", { minutes: e.billableMinutes - limit })
                              : policyError
                                ? t("back_office.billing.time_rule")
                                : priceNotice
                                  ? t("back_office.billing.pricing")
                                  : e.suggestion
                                    ? t("back_office.billing.suggestion")
                                    : null}
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow>
                          <TableCell colSpan={showSelection ? 5 : 4}>
                            <div className="bo-billing-subrow">
                              <span>{t(entryStatusKeys[access.authorized && access.direct ? "approved" : e.status])}</span>
                              {e.activity && <span>{t("back_office.billing.activity_code")} · {currentPolicy.activityLabels[e.activity] || e.activity}</span>}
                              {e.submittedNarrative && e.submittedNarrative !== billedLine.narrative && <div>
                                <small>{t("back_office.billing.submitted_text")}</small>{e.submittedNarrative}
                              </div>}
                              {e.legacy && (e.status === "confirmed" && e.workerId === state.userId ?
                                <Link className="bo-invoice-link" state={{ timeWorkspaceTab: "entries" }} to={timeRoutes.timesheets + "?date=" + e.date}>
                                  {t("invoiceReview.imported_edit")}</Link> : <span>{t("invoiceReview.imported_locked")}</span>)}
                              {state.supportsBillingClientAssignment && e.billable && !e.clientId && info.eligible &&
                                <label>{t("timesheets.sheet.bill_to")}
                                  <TimeSelect label={t("timesheets.sheet.bill_to")} value="" disabled={pending}
                                    placeholder={t("timesheets.sheet.choose_bill_to")}
                                    options={state.clients.filter(client => state.matters.find(matter => matter.id === e.matterId)?.clientIds.includes(client.id))}
                                    onChange={clientId => void send({ type: "assignBillingClient", id: e.id, revision: e.revision, clientId }).catch(() => {})} /></label>}
                              {e.suggestion && (
                                <>
                                  <div>
                                    <small>{t("back_office.billing.suggestion")}</small>
                                    {e.suggestion}
                                  </div>
                                  {canEditLine && (
                                    <div className="bo-billing-wording-actions">
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={pending}
                                        onClick={() =>
                                          void send({
                                            type: "declineSuggestion",
                                            id: e.id,
                                            revision: e.revision,
                                          }).catch(() => {})
                                        }
                                      >
                                        {t("back_office.billing.dismiss")}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pending}
                                        onClick={() => {
                                          if (e.suggestion)
                                            void send({
                                              type: "review",
                                              id: e.id,
                                              revision: e.revision,
                                              narrative: e.suggestion,
                                              billableMinutes: e.billableMinutes,
                                            }).catch(() => {});
                                        }}
                                      >
                                        {t("back_office.billing.apply")}
                                      </Button>
                                    </div>
                                  )}
                                </>
                              )}
                              {policyError && (
                                <span className="bo-billing-error">
                                  {overCap
                                    ? t("back_office.billing.cap_detail", {
                                        minutes: e.billableMinutes,
                                        limit,
                                        code: e.activity,
                                      })
                                    : policyError}
                                </span>
                              )}
                              {priceNotice && <span className="bo-billing-error">{t(priceNotice)}</span>}
                            </div>
                            {renderRecordHistory ? <Button size="sm" variant="ghost" onClick={() => setHistoryId(e.id)}>
                              <History />{t("timesheets.ledger.history")}</Button> : <BillingHistory e={e} state={state} />}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            {!rows.length && <p className="bo-billing-notice">{t("back_office.billing.no_entries")}</p>}
          </div>
          <footer className="bo-billing-footer">
            <span>
              {t("back_office.billing.total", {
                count: rows.length,
                fee: feeSummary(rows.map(pricedEntry)),
              })}
            </span>
            {selected.length > 0 && (
              <>
                <strong>
                  {t("back_office.billing.selection", {
                    count: selected.length,
                    fee: feeSummary(selected.map(pricedEntry)),
                  })}
                </strong>
                {mode === "submitted" ? (
                  <>
                    <BillingWordingCheck
                      key={JSON.stringify(refs(selected))}
                      selected={selected}
                      policies={state.policies}
                      people={groups.people}
                      disabled={pending || draftCells.size > 0}
                      apply={(entries) => send({ type: "applyWording", entries }).then(reset)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        pending ||
                        draftCells.size > 0 ||
                        selected.some((e) => {
                          const info = reviewInfo.get(e.id);
                          return Boolean(info?.error || info?.priceIssue);
                        })
                      }
                      onClick={() =>
                        void send({ type: "approve", entries: refs(selected) })
                          .then(reset)
                          .catch(() => {})
                      }
                    >
                      {t("back_office.billing.approve")}
                    </Button>
                  </>
                ) : null}
                {(mode === "submitted" || (canReturnUnpriced && !hasPendingCorrections)) && (
                  <>
                    <Input className="w-auto"
                      aria-label={t("back_office.billing.return_reason")}
                      placeholder={t("back_office.billing.return_reason")}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || draftCells.size > 0}
                      onClick={returnSelection}
                    >
                      {t(mode === "submitted" ? "back_office.billing.return" : "back_office.billing.price_return")}
                    </Button>
                  </>
                )}
              </>
            )}
          </footer>
        </>
      )}
      {historyEntry && renderRecordHistory?.(historyEntry, () => setHistoryId(""))}
      {(error || downloadError) && (
        <div className="bo-billing-error" role="alert">
          {error || downloadError}
        </div>
      )}
      </section>
      )}
    </>
  );
}
