import { historyActionKeys, historyFieldKeys, labelForCode, reviewViewKeys } from "./timesheet-labels";
import { formatInvoiceMinor } from "@legalwork/types/invoice-template";
import { Link } from "react-router-dom";
import { Fragment, useCallback, useMemo, useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
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
import { BillingOptions, feeSummary, useBillingAction, type BillingProps } from "./billing-components";
import { formatFee, reviewPeriod } from "./billing-amounts";
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
}: BillingProps & {
  canEdit: boolean;
  initialDate?: string;
  initialMatterId?: string;
  workdayModels?: WorkdayModelOption[];
  initialMode?: "submitted" | "invoices";
  client: Pick<LegalworkServerClient, "downloadTimesheetInvoice" | "downloadTimesheetAdjustment" | "downloadTimesheetDraft">;
}) {
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [dates, setDates] = useState(() =>
    reviewPeriod(initialDate ? new Date(initialDate + "T12:00:00") : new Date()),
  );
  const [allUnbilled, setAllUnbilled] = useState(false);
  const throughEndDate = mode === "approved" && allUnbilled;
  const [matter, setMatter] = useState(initialMatterId);
  const [billTo, setBillTo] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [revisionPick, setRevisionPick] = useState(new Map<string, number>());
  const [detail, setDetail] = useState("");
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
      (!throughEndDate || (e.billable && !e.legacy)) &&
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
    .filter((e) => e.status === mode && (mode !== "submitted" || !onlyIssues || issues(e)))
    .sort((a, b) => {
      const priority =
        mode === "submitted"
          ? Number(reviewInfo.get(b.id)?.overCap) - Number(reviewInfo.get(a.id)?.overCap)
          : 0;
      return priority || a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    });
  const eligibleRows = rows.filter((e) =>
    mode === "approved" ? state.canReview && canEdit : reviewInfo.get(e.id)?.eligible,
  );
  const selected = eligibleRows.filter((e) => revisionPick.get(e.id) === e.revision);
  const adjustments = state.adjustments ?? [];
  const effective = (line: TimeEntry) =>
    mode === "approved" ? adjustedTimeEntry(line, adjustments) : line;
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
    setDownloadError("");
  };
  const invoices = state.invoices
    .filter(
      (i) =>
        (!billTo || billTo === i.clientId) &&
        i.entries.some(
          (e) =>
            (!matter || matter === e.matterId) &&
            (!dates.from || e.date >= dates.from) &&
            (!dates.to || e.date <= dates.to),
        ),
    )
    .sort((a, b) => b.number - a.number);
  function returnSelection() {
    void send({ type: "return", entries: refs(selected), reason: reason.trim() || undefined }).then(reset).catch(() => {});
  }
  async function download(id: string, number?: number, format?: "docx" | "pdf") {
    setDownloadError("");
    try {
      const file =
        number === undefined
          ? await client.downloadTimesheetAdjustment(id, state.scope)
          : await client.downloadTimesheetInvoice(id, state.scope, format);
      saveInvoiceDownload(file, number === undefined ? "Adjustment-" + id + ".html" : "Invoice-" + number + "." + (format ?? "html"));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t("back_office.billing.download_failed"));
    }
  }
  const canCreate = state.canReview && canEdit && state.supportsInvoiceDrafts === true;
  const invoiceEditing = invoiceScreen !== "closed" && canCreate;
  const invoiceVisible = invoiceScreen === "invoice" && canCreate;
  return (
    <>
      {invoiceEditing && (
        <div hidden={!invoiceVisible}>
          <section className="bo-billing">
            <BillingInvoiceDraft
              state={state} onCommand={onCommand} client={client} dates={dates} initialMatterId={matter} workdayModels={workdayModels}
              onCancel={() => setInvoiceScreen("closed")}
              onReviewSubmitted={(entry) => {
                reset();
                setDates({ from: entry.date, to: entry.date });
                setMatter(entry.matterId ?? "");
                setBillTo(entry.clientId ?? "");
                setOnlyIssues(false);
                setDetail(entry.id);
                setMode("submitted");
                setInvoiceScreen("review");
              }}
              onIssued={() => { reset(); setDates({ from: "", to: "" }); setInvoiceScreen("closed"); setMode("invoices"); }}
            />
          </section>
        </div>
      )}
      {!invoiceVisible && (
      <section className="bo-billing">
      <div className="bo-view-toolbar">
        <select
          aria-label={t("back_office.billing.view")}
          value={mode}
          onChange={(e) => {
            const next = (["submitted", "approved", "adjustments", "invoices", "costs"] as const).find(
              (v) => v === e.target.value,
            );
            if (next) {
              setMode(next);
              reset();
            }
          }}
        >
          {(["submitted", "approved", "adjustments", "invoices", "costs"] as const).map((k) => (
            <option key={k} value={k}>
              {t(reviewViewKeys[k])}
            </option>
          ))}
        </select>
        <label>
          {t("back_office.billing.from")}
          <input
            type="date"
            disabled={throughEndDate}
            value={throughEndDate ? "" : dates.from}
            onChange={(e) => {
              setDates({ ...dates, from: e.target.value });
              reset();
            }}
          />
        </label>
        <label>
          {t("back_office.billing.to")}
          <input
            type="date"
            value={dates.to}
            onChange={(e) => {
              setDates({ ...dates, to: e.target.value });
              reset();
            }}
          />
        </label>
        {mode === "approved" && <label>
          <input type="checkbox" checked={allUnbilled} onChange={e => {
            setAllUnbilled(e.target.checked);
            reset();
          }} />
          {t("back_office.billing.all_unbilled")}
        </label>}
        <select
          aria-label={t("back_office.billing.client")}
          value={billTo}
          onChange={(e) => {
            setBillTo(e.target.value);
            setMatter("");
            reset();
          }}
        >
          <option value="">{t("back_office.billing.all_clients")}</option>
          <BillingOptions options={state.clients} />
        </select>
        <select
          aria-label={t("back_office.billing.matter")}
          value={matter}
          onChange={(e) => {
            setMatter(e.target.value);
            reset();
          }}
        >
          <option value="">{t("back_office.billing.all_matters")}</option>
          <BillingOptions
            options={state.matters.filter((m) => !billTo || m.clientIds.includes(billTo))}
          />
        </select>
        {(matter || billTo) && (
          <Link className="bo-time-secondary" to={"/settings/billing?" + new URLSearchParams({
            ...(matter ? { matter } : { client: billTo }),
            date: dates.from || reviewPeriod().to,
          })}>{t("timesheets.review_rules")}</Link>
        )}
        {(mode === "submitted" || mode === "approved" || mode === "invoices") && state.canReview && canEdit && (
          canCreate ? <Button size="sm" variant="outline" onClick={() => setInvoiceScreen("invoice")}>
            {t(invoiceScreen === "review" || state.invoiceDraft && (!matter || state.invoiceDraft.input.matterId === matter) ? "invoiceReview.resume" : "invoiceReview.create")}
          </Button> : <span className="bo-billing-muted">{t("invoiceReview.firm_unavailable")}</span>
        )}
        {mode === "submitted" && (
          <label>
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(e) => {
                setOnlyIssues(e.target.checked);
                reset();
              }}
            />
            {t("back_office.billing.only_issues", { count: issuesCount })}
          </label>
        )}
      </div>
      {mode === "adjustments" ? (
        <BillingAdjustments
          rows={all}
          canEdit={canEdit}
          state={state}
          onCommand={onCommand}
          download={(id) => download(id)}
        />
      ) : mode === "costs" ? (
        <BillingCosts rows={all} state={state} onCommand={onCommand} />
      ) : mode === "invoices" ? (
        <div className="bo-billing-body">
          <table>
            <thead>
              <tr>
                {["back_office.billing.invoice_number", "back_office.billing.issued", "back_office.billing.client", "back_office.billing.positions", "back_office.billing.fees", "back_office.billing.document"].map((k) => (
                  <th key={k}>{t(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.number}</td>
                  <td>{new Date(i.issuedAt).toLocaleDateString(locale)}</td>
                  <td>{groups.clients.get(i.clientId) || i.clientId}</td>
                  <td>{i.entries.length}</td>
                  <td>{i.totalMinor === undefined ? formatFee(locale, i.total, i.currency) : formatInvoiceMinor(locale, i.currency, i.totalMinor)}</td>
                  <td>
                    {i.snapshot ? (["docx", "pdf"] as const).map((format) => (
                      <Button key={format} size="sm" variant="ghost" onClick={() => void download(i.id, i.number, format)}>
                        {format.toUpperCase()}
                      </Button>
                    )) : <button
                      type="button"
                      aria-label={t("back_office.billing.download")}
                      onClick={() => void download(i.id, i.number)}
                    >
                      <Download size={15} />
                    </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!invoices.length && (
            <p className="bo-billing-notice">{t("back_office.billing.no_invoices")}</p>
          )}
        </div>
      ) : (
        <>
          <div className="bo-billing-body">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={t("back_office.billing.select_all")}
                      disabled={pending || !eligibleRows.length}
                      checked={eligibleRows.length > 0 && eligibleRows.length === selected.length}
                      ref={(node) => {
                        if (node)
                          node.indeterminate =
                            selected.length > 0 && selected.length < eligibleRows.length;
                      }}
                      onChange={(e) => {
                        setRevisionPick(
                          e.target.checked
                            ? new Map(eligibleRows.map((r) => [r.id, r.revision]))
                            : new Map(),
                        );
                      }}
                    />
                  </th>
                  {[
                    "back_office.billing.date",
                    "back_office.billing.matter",
                    "back_office.billing.worker",
                    "back_office.billing.activity_code",
                    "back_office.billing.narrative",
                    "back_office.billing.charge",
                    "back_office.billing.fees",
                    "back_office.billing.detail",
                  ].map((k) => (
                    <th key={k}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
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
                  const unpriced = mode === "approved" && e.billable && !e.legacy && !hasTimeEntryPrice(e);
                  const priceNotice = unpriced
                    ? e.nonHourlyApproval || currentPolicy.nonHourlyAgreement
                      ? "back_office.billing.non_hourly"
                      : "back_office.billing.price_return_help"
                    : priceIssue;
                  return (
                    <Fragment key={e.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t("back_office.billing.select_line", { label: e.narrative })}
                            checked={revisionPick.get(e.id) === e.revision}
                            disabled={pending || !(mode === "approved" ? state.canReview && canEdit : canEditLine)}
                            onChange={(v) => pick(e, v.target.checked)}
                          />
                        </td>
                        <td>{e.date}</td>
                        <td>{groups.matters.get(e.matterId) || e.matterId}</td>
                        <td>{groups.people.get(e.workerId) || e.workerId}</td>
                        <td>{e.activity}</td>
                        <td>
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
                        </td>
                        <td className="bo-billing-number">
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
                        </td>
                        <td className="bo-billing-number">{feeSummary([effective(e)])}</td>
                        <td>
                          <button
                            type="button"
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
                            className={"bo-billing-cell-action" + (overCap ? " bo-billing-cap" : "")}
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
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={9}>
                            <div className="bo-billing-subrow">
                              <div>
                                <small>{t("back_office.billing.submitted_text")}</small>
                                {e.submittedNarrative ?? e.narrative}
                              </div>
                              {state.supportsBillingClientAssignment && e.billable && !e.clientId && info.eligible &&
                                <label>{t("timesheets.sheet.bill_to")}
                                  <select aria-label={t("timesheets.sheet.bill_to")} value="" disabled={pending}
                                    onChange={event => { const clientId = event.target.value; if (clientId) void send({ type: "assignBillingClient", id: e.id, revision: e.revision, clientId }).catch(() => {}); }}>
                                    <option value="">{t("timesheets.sheet.choose_bill_to")}</option>
                                    <BillingOptions options={state.clients.filter(client => state.matters.find(m => m.id === e.matterId)?.clientIds.includes(client.id))} />
                                  </select></label>}
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
                            <BillingHistory e={e} state={state} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && <p className="bo-billing-notice">{t("back_office.billing.no_entries")}</p>}
          </div>
          <footer className="bo-billing-footer">
            <span>
              {t("back_office.billing.total", {
                count: rows.length,
                fee: feeSummary(rows.map(effective)),
              })}
            </span>
            {selected.length > 0 && (
              <>
                <strong>
                  {t("back_office.billing.selection", {
                    count: selected.length,
                    fee: feeSummary(selected.map(effective)),
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
                    <input
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
