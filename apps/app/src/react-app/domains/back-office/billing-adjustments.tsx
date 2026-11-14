import { adjustmentStatusKeys } from "./timesheet-labels";
import { Fragment, useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import { Download } from "lucide-react";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { resolveTimePolicy, type TimeAdjustment, type TimeEntry } from "@legalwork/types/timesheet";
import { useBillingAction, type BillingProps } from "./billing-components";

export function BillingAdjustments({
  rows,
  state,
  onCommand,
  download,
}: BillingProps & {
  rows: TimeEntry[];
  download: (id: string) => Promise<void>;
}) {
  const [onlyPending, setOnlyPending] = useState(true);
  const [expanded, setExpanded] = useState("");
  const { send, error, pending } = useBillingAction(onCommand);
  const locale = useLocale();
  const entries = new Map(rows.map((e) => [e.id, e]));
  const adjustments = (state.adjustments ?? [])
    .filter((a) => entries.has(a.entryId) && (!onlyPending || a.status === "pending"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const adjustmentLabel = (adjustment: TimeAdjustment) => {
    if (!adjustment.currency || adjustment.deltaAmount === null)
      return t("back_office.billing.unpriced", { count: 1 });
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: adjustment.currency,
      signDisplay: "exceptZero",
    }).format(adjustment.deltaAmount);
  };
  return (
    <>
      <div className="bo-view-toolbar">
        <label>
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
          />
          {t("back_office.billing.pending_changes")}
        </label>
      </div>
      <div className="bo-billing-body">
        <table>
          <thead>
            <tr>
              {[
                "back_office.billing.date",
                "back_office.billing.worker",
                "back_office.billing.original_charge",
                "back_office.billing.new_charge",
                "back_office.billing.difference",
                "back_office.billing.change_reason",
                "back_office.billing.detail",
              ].map((k) => (
                <th key={k}>{t(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {adjustments.map((a) => {
              const line = entries.get(a.entryId)!;
              const policy = resolveTimePolicy(
                state.policies,
                line.clientId,
                line.matterId,
                line.date,
                line.projectId,
              );
              const solo = state.scope === "local" && policy.soloApproval;
              const eligible =
                state.canManage &&
                (policy.reviewerId === state.userId || (solo && !policy.reviewerId)) &&
                (a.authorId !== state.userId || solo) &&
                (line.workerId !== state.userId || solo);
              const decide = (approve: boolean) =>
                void send({ type: "decideAdjustment", id: a.id, revision: a.revision, approve }).catch(
                  () => {},
                );
              const invoice = a.invoiceId ? state.invoices.find((i) => i.id === a.invoiceId) : undefined;
              return (
                <Fragment key={a.id}>
                  <tr>
                    <td>{line.date}</td>
                    <td>{state.people.find((p) => p.id === line.workerId)?.name ?? line.workerId}</td>
                    <td>{a.fromMinutes}</td>
                    <td>{a.toMinutes}</td>
                    <td>{adjustmentLabel(a)}</td>
                    <td>
                      <button
                        type="button"
                        aria-expanded={expanded === a.id}
                        onClick={() => setExpanded(expanded === a.id ? "" : a.id)}
                      >
                        {a.reason}
                      </button>
                    </td>
                    <td>
                      {a.status === "pending" && eligible ? (
                        <div className="bo-view-actions">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => decide(true)}
                          >
                            {t("back_office.billing.approve_change")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => decide(false)}
                          >
                            {t("back_office.billing.decline_change")}
                          </Button>
                        </div>
                      ) : (
                        t(adjustmentStatusKeys[a.status])
                      )}
                      {a.status === "approved" && a.invoiceId && (
                        <button
                          type="button"
                          aria-label={t("back_office.billing.download_note")}
                          onClick={() => void download(a.id)}
                        >
                          <Download size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === a.id && (
                    <tr>
                      <td colSpan={7}>
                        <div className="bo-billing-subrow">
                          <div>
                            <small>{t("back_office.billing.original_line")}</small>
                            {line.date} · {line.activity} · {line.narrative} ·{" "}
                            {t("back_office.billing.version", { n: a.baseRevision })}
                          </div>
                          <div>
                            <small>{t("back_office.billing.change_text")}</small>
                            {a.narrative}
                          </div>
                          <div>
                            <small>{t("back_office.billing.requested_by")}</small>
                            {state.people.find((p) => p.id === a.authorId)?.name ?? a.authorId} ·{" "}
                            {new Date(a.createdAt).toLocaleString(locale)}
                          </div>
                          {a.reviewedAt && (
                            <div>
                              <small>{t("back_office.billing.decided_by")}</small>
                              {state.people.find((p) => p.id === a.reviewerId)?.name ??
                                a.reviewerId} · {new Date(a.reviewedAt).toLocaleString(locale)}
                            </div>
                          )}
                          {invoice && (
                            <div>
                              <small>{t("back_office.billing.invoice_number")}</small>
                              {invoice.number}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!adjustments.length && (
          <p className="bo-billing-notice">{t("back_office.billing.no_adjustments")}</p>
        )}
      </div>
      {error && (
        <p role="alert" className="bo-billing-error">
          {error}
        </p>
      )}
    </>
  );
}
