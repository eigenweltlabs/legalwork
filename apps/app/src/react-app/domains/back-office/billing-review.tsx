import { renderInvoice, standardInvoice } from "@legalwork/types/invoice-template";
import { Fragment, useMemo, useRef, useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import {
  type TimeEntry,
  type TimesheetState,
  adjustedTimeEntry,
  resolveTimePolicy,
  timePolicyError,
  timeCapWarning,
} from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
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
function eligible(state: TimesheetState, entry: TimeEntry, p: ReturnType<typeof resolveTimePolicy>) {
  const solo = state.scope === "local" && p.soloApproval;
  return (
    state.canManage &&
    (p.reviewerId === state.userId || (solo && !p.reviewerId)) &&
    (entry.workerId !== state.userId || solo)
  );
}
const refs = (entries: TimeEntry[]) => entries.map(({ id, revision }) => ({ id, revision }));

function BillingHistory({ e, state }: { e: TimeEntry; state: TimesheetState }) {
  return (
    <details>
      <summary>{t("back_office.billing.history")}</summary>
      <ol className="bo-billing-history">
        {e.history.map((h) => (
          <li key={h.revision}>
            <small>
              {new Date(h.at).toLocaleString()} ·{" "}
              {state.people.find((p) => p.id === h.actorId)?.name || h.actorId} ·{" "}
              {t("back_office.billing.version", { n: h.revision })}
            </small>
            <div>
              {h.before && h.before.narrative !== h.after.narrative && (
                <del>{h.before.narrative} → </del>
              )}
              {h.after.narrative} ·{" "}
              {h.before && h.before.billableMinutes !== h.after.billableMinutes && (
                <del>{h.before.billableMinutes} → </del>
              )}
              {h.after.billableMinutes} min · {h.action}
            </div>
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
  initialDate,
}: BillingProps & {
  initialDate?: string;
  client: Pick<LegalworkServerClient, "downloadTimesheetInvoice" | "downloadTimesheetAdjustment">;
}) {
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>("submitted");
  const [dates, setDates] = useState(() =>
    reviewPeriod(initialDate ? new Date(initialDate + "T12:00:00") : new Date()),
  );
  const [matter, setMatter] = useState("");
  const [billTo, setBillTo] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [revisionPick, setRevisionPick] = useState(new Map<string, number>());
  const [detail, setDetail] = useState("");
  const [reason, setReason] = useState("");
  const [draftCells, setDraftCells] = useState(new Set<string>());
  const editCell = (key: string, active: boolean) =>
    setDraftCells((previous) => {
      const next = new Set(previous);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  const [previewKey, setPreview] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const request = useRef({ key: "", id: "" });
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
      (!dates.from || dates.from <= e.date) &&
      (!dates.to || e.date <= dates.to) &&
      (!matter || matter === e.matterId) &&
      (!billTo || billTo === e.clientId),
  );
  const reviewInfo = useMemo(
    () =>
      new Map(
        state.entries.map((entry) => {
          const policy = policyFor(state, entry);
          return [
            entry.id,
            {
              policy,
              overCap: Boolean(timeCapWarning(entry, policy)),
              error: timePolicyError(entry, policy),
              eligible: eligible(state, entry, policy),
            },
          ] as const;
        }),
      ),
    [state.entries, state.policies, state.userId, state.canManage, state.scope],
  );
  const issues = (e: TimeEntry) => e.suggestion || reviewInfo.get(e.id)?.error;
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
    mode === "approved" ? state.canReview : reviewInfo.get(e.id)?.eligible,
  );
  const selected = eligibleRows.filter((e) => revisionPick.get(e.id) === e.revision);
  const adjustments = state.adjustments ?? [];
  const effective = (line: TimeEntry) =>
    mode === "approved" ? adjustedTimeEntry(line, adjustments) : line;
  const linkedAdjustments = adjustments.filter((a) => selected.some((line) => line.id === a.entryId));
  const adjustmentVersions = linkedAdjustments
    .filter((a) => a.status === "approved")
    .map(({ id, revision }) => ({ id, revision }));
  const hasPendingCorrections = linkedAdjustments.some((a) => a.status === "pending");
  const creditState = linkedAdjustments.map((a) => [a.id, a.revision]);
  const invoiceKey = JSON.stringify([state.template?.revision ?? 0, refs(selected), creditState]);
  const preview = previewKey === invoiceKey;
  const issuesCount = all.filter((e) => e.status === "submitted" && issues(e)).length;
  const pick = (e: TimeEntry, checked: boolean) => {
    setPreview("");
    setRevisionPick((prev) => {
      const next = new Map(prev);
      if (checked) next.set(e.id, e.revision);
      else next.delete(e.id);
      return next;
    });
  };
  const reset = () => {
    setRevisionPick(new Map());
    setDraftCells(new Set());
    setPreview("");
    setDetail("");
    setReason("");
    setDownloadError("");
  };
  const invoiceable =
    !hasPendingCorrections &&
    selected.length > 0 &&
    selected.every(
      (e) =>
        !e.legacy &&
        e.billable &&
        e.matterId === selected[0].matterId &&
        e.clientId &&
        e.clientId === selected[0].clientId &&
        !!e.currency &&
        e.currency === selected[0].currency &&
        e.hourlyRate !== undefined,
    );
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
  async function issue() {
    if (!invoiceable || !preview) return;
    if (request.current.key !== invoiceKey)
      request.current = { key: invoiceKey, id: crypto.randomUUID() };
    try {
      await send({
        type: "invoice",
        adjustmentVersions,
        templateRevision: state.template?.revision ?? 0,
        requestId: request.current.id,
        entries: refs(selected),
      });
      reset();
      setMode("invoices");
    } catch {
      /* Keep the same request ID for retry. */
    }
  }
  async function download(id: string, number?: number) {
    setDownloadError("");
    try {
      const file =
        number === undefined
          ? await client.downloadTimesheetAdjustment(id, state.scope)
          : await client.downloadTimesheetInvoice(id, state.scope);
      const url = URL.createObjectURL(new Blob([file.data], { type: "text/html" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = number === undefined ? "Adjustment-" + id + ".html" : "Invoice-" + number + ".html";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t("back_office.billing.download_failed"));
    }
  }
  return (
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
              {t("back_office.billing.view_" + k)}
            </option>
          ))}
        </select>
        <label>
          {t("back_office.billing.from")}
          <input
            type="date"
            value={dates.from}
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
                {["invoice_number", "issued", "client", "positions", "fees", "document"].map((k) => (
                  <th key={k}>{t("back_office.billing." + k)}</th>
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
                  <td>{formatFee(locale, i.total, i.currency)}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={t("back_office.billing.download")}
                      onClick={() => void download(i.id, i.number)}
                    >
                      <Download size={15} />
                    </button>
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
                        setPreview("");
                      }}
                    />
                  </th>
                  {[
                    "date",
                    "matter",
                    "worker",
                    "activity_code",
                    "narrative",
                    "charge",
                    "fees",
                    "detail",
                  ].map((k) => (
                    <th key={k}>{t("back_office.billing." + k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const info = reviewInfo.get(e.id)!;
                  const canEdit = info.eligible && mode === "submitted",
                    open = detail === e.id,
                    detailLabel = e.suggestion
                      ? t("back_office.billing.suggestion")
                      : t("back_office.billing.details");
                  const currentPolicy = info.policy;
                  const limit = currentPolicy.activityLimits[e.activity] ?? currentPolicy.maxMinutes;
                  const overCap = mode === "submitted" && info.overCap;
                  const policyError = info.error;
                  return (
                    <Fragment key={e.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t("back_office.billing.select_line", { label: e.narrative })}
                            checked={revisionPick.get(e.id) === e.revision}
                            disabled={pending || !(mode === "approved" ? state.canReview : canEdit)}
                            onChange={(v) => pick(e, v.target.checked)}
                          />
                        </td>
                        <td>{e.date}</td>
                        <td>{groups.matters.get(e.matterId) || e.matterId}</td>
                        <td>{groups.people.get(e.workerId) || e.workerId}</td>
                        <td>{e.activity}</td>
                        <td>
                          <BillingEditCell
                            onEditing={(active) => editCell(e.id + "/text", active)}
                            label={t("back_office.billing.narrative")}
                            value={effective(e).narrative}
                            disabled={!canEdit}
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
                            onEditing={(active) => editCell(e.id + "/minutes", active)}
                            label={t("back_office.billing.charge")}
                            numeric
                            value={String(effective(e).billableMinutes)}
                            disabled={!canEdit}
                            requireReason
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
                              {e.suggestion && (
                                <>
                                  <div>
                                    <small>{t("back_office.billing.suggestion")}</small>
                                    {e.suggestion}
                                  </div>
                                  {canEdit && (
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
                                  )}
                                  {canEdit && (
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        pending ||
                        draftCells.size > 0 ||
                        selected.some((e) => Boolean(reviewInfo.get(e.id)?.error))
                      }
                      onClick={() =>
                        void send({ type: "approve", entries: refs(selected) })
                          .then(reset)
                          .catch(() => {})
                      }
                    >
                      {t("back_office.billing.approve")}
                    </Button>
                    <input
                      aria-label={t("back_office.billing.return_reason")}
                      placeholder={t("back_office.billing.return_reason")}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || draftCells.size > 0 || !reason.trim()}
                      onClick={() =>
                        void send({ type: "return", entries: refs(selected), reason: reason.trim() })
                          .then(reset)
                          .catch(() => {})
                      }
                    >
                      {t("back_office.billing.return")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !invoiceable}
                      onClick={() => setPreview(invoiceKey)}
                    >
                      {t("back_office.billing.preview")}
                    </Button>
                    {!invoiceable && (
                      <span>
                        {t(
                          hasPendingCorrections
                            ? "back_office.billing.invoice_correction_pending"
                            : "back_office.billing.invoice_requirements",
                        )}
                      </span>
                    )}
                  </>
                )}
              </>
            )}
          </footer>
          {preview && selected.length > 0 && (
            <div className="bo-billing-subrow">
              <iframe
                className="bo-invoice-preview"
                title={t("timesheets.template_preview")}
                sandbox=""
                srcDoc={renderInvoice(state.template ?? standardInvoice, {
                  client: groups.clients.get(selected[0].clientId) || selected[0].clientId,
                  entries: selected.map(effective),
                  currency: selected[0].currency!,
                  date: new Date().toISOString().slice(0, 10),
                })}
              />
              <span>
                {t("back_office.billing.invoice_preview", {
                  client: groups.clients.get(selected[0].clientId) || selected[0].clientId,
                  count: selected.length,
                  fee: feeSummary(selected.map(effective)),
                })}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !invoiceable}
                onClick={() => void issue()}
              >
                {t("back_office.billing.issue")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreview("")}>
                {t("common.cancel")}
              </Button>
            </div>
          )}
        </>
      )}
      {(error || downloadError) && (
        <div className="bo-billing-error" role="alert">
          {error || downloadError}
        </div>
      )}
    </section>
  );
}
