import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "twenty-ui/primitives/input";
import { checkBillingNarrative } from "@legalwork/types/billing-narrative";
import {
  localWorkdayModel,
  type WorkdayModelOption,
} from "@legalwork/types/time-capture";
import {
  currencyScale,
  formatInvoiceHours,
  formatInvoiceMinor,
  renderInvoice,
} from "@legalwork/types/invoice-template";
import {
  InvoiceDraftInputSchema,
  adjustedTimeEntry,
  appliesTimeAdjustment,
  resolveTimePolicy,
  type TimeInvoiceDraft,
} from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  BillingOptions,
  useBillingAction,
  type BillingProps,
} from "./billing-components";
import { reviewPeriod } from "./billing-amounts";
import { entryStatusKeys } from "./timesheet-labels";
import { timeRoutes } from "./time-routes";

type DraftProps = BillingProps & {
  client: Pick<LegalworkServerClient, "downloadTimesheetDraft">;
  initialMatterId: string;
  workdayModels?: WorkdayModelOption[];
  dates: { from: string; to: string };
  onCancel: () => void;
  onReviewSubmitted: () => void;
  onIssued: () => void;
};

export function saveInvoiceDownload(
  file: {
    data: ArrayBuffer;
    contentType: string | null;
    filename: string | null;
  },
  fallback: string,
) {
  const url = URL.createObjectURL(
    new Blob([file.data], {
      type: file.contentType ?? "application/octet-stream",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename ?? fallback;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
                  entry.status === "approved" &&
                  entry.date <= saved.period.to &&
                  (!saved.period.from || entry.date >= saved.period.from),
              )
              .map((entry) => entry.id)
          : [],
      ),
  );
  const [wording, setWording] = useState(new Set(saved?.wording));
  const [edits, setEdits] = useState(
    new Map(saved?.edits?.map(({ id, narrative }) => [id, narrative])),
  );
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
  const [downloadError, setDownloadError] = useState("");
  const { send, error, pending } = useBillingAction(onCommand);
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
  const checks = rows.map((entry) => {
    const line = adjustedTimeEntry(entry, adjustments);
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
    const eligible =
      entry.status === "approved" &&
      !entry.legacy &&
      entry.billable &&
      entry.clientId === clientId &&
      reviewer;
    const picked = eligible && (allOpen || !excluded.has(entry.id));
    const preparedLine = draft?.lines.find(
      (item) =>
        item.entry.id === entry.id &&
        item.entry.revision === entry.revision &&
        item.currentNarrative === line.narrative,
    );
    const check = checkBillingNarrative(line, policy);
    const suggested = preparedLine
      ? preparedLine.suggestedNarrative
      : check?.narrative;
    const rules = preparedLine
      ? [...preparedLine.rules]
      : [...(check?.replacements ?? [])].map(
          ([before, after]) => before + " → " + after,
        );
    const actionFirst = preparedLine
      ? preparedLine.actionFirst
      : check?.actionFirst;
    if (actionFirst) rules.push(t("back_office.billing.action_first"));
    return { entry, line, preparedLine, rules, suggested, eligible, picked };
  });
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
  const invoiceCurrency = fixed ? currency : included[0]?.currency;
  const scale =
    invoiceCurrency && /^[A-Z]{3}$/.test(invoiceCurrency)
      ? currencyScale(invoiceCurrency)
      : 100;
  const selectedScope =
    scope === "people"
      ? new Set(included.map(({ workerId }) => workerId))
      : new Set(included.map(({ id }) => id));
  const selectionIds = [...selectedScope].filter((id) => scopeIds.has(id));
  const selectedWording = checks.flatMap(({ picked, entry, suggested }) =>
    picked && suggested && wording.has(entry.id)
      ? [{ id: entry.id, narrative: suggested }]
      : [],
  );
  const editedWording = included.flatMap(({ id }) => {
    const narrative = edits.get(id);
    return narrative === undefined ? [] : [{ id, narrative }];
  });
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
      : { mode: "hourly" },
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
  const visibleDraft =
    input.success &&
    draft &&
    JSON.stringify(input.data) === JSON.stringify(draft.input) &&
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
    setExcluded(new Set());
    setWording(new Set());
    setEdits(new Map());
    setScopeIds(new Set());
  }
  function toggleSuggestion(id: string, checked: boolean) {
    setWording((previous) => updateCheck(previous, id, checked));
    if (checked) editWording(id, undefined);
  }
  function editWording(id: string, narrative: string | undefined) {
    setEdits((previous) => {
      const next = new Map(previous);
      if (narrative === undefined) next.delete(id);
      else next.set(id, narrative);
      return next;
    });
    if (narrative !== undefined)
      setWording((previous) => updateCheck(previous, id, false));
  }
  async function download(draft: TimeInvoiceDraft, format: "docx" | "pdf") {
    setDownloadError("");
    try {
      saveInvoiceDownload(
        await client.downloadTimesheetDraft(draft.id, state.scope, format),
        "Invoice-preview." + format,
      );
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : t("back_office.billing.download_failed"),
      );
    }
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

  return (
    <div className="bo-billing-body bo-invoice-draft">
      <header className="bo-billing-header">
        <h2>{t("invoiceReview.create")}</h2>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t("common.back")}
        </Button>
      </header>
      <fieldset disabled={pending}>
        <div className="bo-view-toolbar">
          <label>
            {t("back_office.billing.matter")}
            <select
              value={matterId}
              onChange={(event) => changeMatter(event.target.value)}
            >
              <option value="">{t("invoiceReview.choose_matter")}</option>
              <BillingOptions options={state.matters} />
            </select>
          </label>
          {matter && (
            <label>
              {t("back_office.billing.client")}
              {soleClient ? (
                <strong>{soleClient.name}</strong>
              ) : (
                <select
                  value={clientId}
                  onChange={(event) => {
                    setClient(event.target.value);
                    resetSelection();
                  }}
                >
                  <option value="">{t("invoiceReview.choose_client")}</option>
                  <BillingOptions options={clients} />
                </select>
              )}
            </label>
          )}
        </div>
        {matter && clientId && (
          <>
            <div className="bo-view-toolbar">
              <label>
                <input
                  type="checkbox"
                  checked={allOpen}
                  onChange={(event) => {
                    setAllOpen(event.target.checked);
                    resetSelection();
                  }}
                />
                {t("invoiceReview.all_open")}
              </label>
              {!allOpen && (
                <label>
                  {t("back_office.billing.from")}
                  <input
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </label>
              )}
              <label>
                {t("back_office.billing.to")}
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
              <label>
                {t("invoiceReview.pricing")}
                <select
                  value={fixed ? "fixed" : "hourly"}
                  onChange={(event) => {
                    setFixed(event.target.value === "fixed");
                    if (!currency) setCurrency(included[0]?.currency ?? "EUR");
                  }}
                >
                  <option value="hourly">{t("invoiceReview.hourly")}</option>
                  <option value="fixed">{t("invoiceReview.fixed")}</option>
                </select>
              </label>
              {fixed && (
                <>
                  <label>
                    {t("invoiceReview.agreed_price")}
                    <input
                      inputMode="decimal"
                      value={fixedPrice}
                      onChange={(event) => setFixedPrice(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("invoiceReview.currency")}
                    <input
                      className="bo-invoice-currency"
                      maxLength={3}
                      value={currency}
                      onChange={(event) =>
                        setCurrency(event.target.value.toUpperCase())
                      }
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showHours}
                      onChange={(event) => setShowHours(event.target.checked)}
                    />
                    {t("invoiceReview.show_hours")}
                  </label>
                </>
              )}
            </div>
            {!rows.length && (
              <p className="bo-billing-notice">
                {t("invoiceReview.no_entries")}
              </p>
            )}
            {rows.length > 0 && (
              <>
                <div className="bo-billing-subrow">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !checks.some(
                        ({ entry, suggested, picked }) =>
                          picked &&
                          suggested &&
                          !wording.has(entry.id) &&
                          !edits.has(entry.id),
                      )
                    }
                    onClick={() =>
                      setWording(
                        new Set(
                          checks.flatMap(({ entry, suggested, picked }) =>
                            picked && suggested && !edits.has(entry.id)
                              ? [entry.id]
                              : [],
                          ),
                        ),
                      )
                    }
                  >
                    {t("invoiceReview.apply_suggestions")}
                  </Button>
                </div>
                <div className="bo-invoice-table">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("invoiceReview.include")}</th>
                        <th>{t("invoiceReview.status")}</th>
                        <th>{t("back_office.billing.date")}</th>
                        <th>{t("back_office.billing.worker")}</th>
                        <th>{t("invoiceReview.actual_hours")}</th>
                        <th>{t("invoiceReview.original")}</th>
                        <th>{t("back_office.billing.suggestion")}</th>
                        <th>{t("back_office.billing.wording_rule")}</th>
                        <th>{t("invoiceReview.result")}</th>
                        <th>{t("invoiceReview.base_amount")}</th>
                        <th>{t("invoiceReview.billed")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.map(
                        ({
                          entry,
                          line,
                          preparedLine,
                          rules,
                          suggested,
                          eligible,
                          picked,
                        }) => {
                          const previewLine = visibleDraft?.lines.find(
                            (item) => item.entry.id === entry.id,
                          );
                          const worker =
                            people.get(entry.workerId) ?? entry.workerId;
                          const author =
                            people.get(entry.authorId) ?? entry.authorId;
                          const actualHours = formatInvoiceHours(
                            locale,
                            entry.workedMinutes,
                          );
                          return (
                            <tr key={entry.id}>
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={t(
                                    "back_office.billing.select_line",
                                    { label: line.narrative },
                                  )}
                                  checked={picked}
                                  disabled={allOpen || !eligible}
                                  onChange={(event) =>
                                    setExcluded(
                                      updateCheck(
                                        excluded,
                                        entry.id,
                                        !event.target.checked,
                                      ),
                                    )
                                  }
                                />
                              </td>
                              <td>
                                {t(entryStatusKeys[entry.status])}
                                {entry.status === "confirmed" && (
                                  <small>
                                    {entry.workerId === state.userId ? (
                                      <Link to={timeRoutes.timesheets}>
                                        {t("invoiceReview.submit_open")}
                                      </Link>
                                    ) : (
                                      t("invoiceReview.await_submission")
                                    )}
                                  </small>
                                )}
                                {entry.status === "submitted" && (
                                  <small>
                                    <button
                                      type="button"
                                      className="bo-invoice-link"
                                      onClick={onReviewSubmitted}
                                    >
                                      {t("invoiceReview.review_open")}
                                    </button>
                                  </small>
                                )}
                                {entry.status === "approved" && !eligible && (
                                  <small>
                                    {t("invoiceReview.unavailable_line")}
                                  </small>
                                )}
                              </td>
                              <td>{entry.date}</td>
                              <td>
                                {worker}
                                {author !== worker && (
                                  <small>
                                    {t("invoiceReview.author", {
                                      name: author,
                                    })}
                                  </small>
                                )}
                              </td>
                              <td>{actualHours}</td>
                              <td>
                                {entry.submittedNarrative ?? entry.narrative}
                              </td>
                              <td>
                                {suggested ? (
                                  <label>
                                    <input
                                      type="checkbox"
                                      disabled={!picked}
                                      checked={wording.has(entry.id)}
                                      aria-label={t(
                                        "invoiceReview.apply_suggestion",
                                        { label: line.narrative },
                                      )}
                                      onChange={(event) =>
                                        toggleSuggestion(
                                          entry.id,
                                          event.target.checked,
                                        )
                                      }
                                    />{" "}
                                    {suggested}
                                  </label>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td>
                                {preparedLine?.modelRule
                                  ? t(
                                      `invoiceReview.rule.${preparedLine.modelRule}`,
                                    )
                                  : rules.join(" · ")}
                                {preparedLine?.guidelineVersions?.map(
                                  (version) => (
                                    <small key={version.id}>
                                      {t("invoiceReview.guidelineVersion", {
                                        name: version.name,
                                        revision: version.revision,
                                        date: version.effectiveFrom,
                                      })}
                                    </small>
                                  ),
                                )}
                                {!preparedLine?.modelRule &&
                                  !rules.length &&
                                  !preparedLine?.guidelineVersions?.length &&
                                  "—"}
                              </td>
                              <td>
                                {eligible ? (
                                  <>
                                    <textarea
                                      rows={2}
                                      maxLength={2000}
                                      disabled={!picked}
                                      aria-label={t(
                                        "invoiceReview.edit_wording",
                                        { label: line.narrative },
                                      )}
                                      value={
                                        edits.get(entry.id) ??
                                        previewLine?.entry.narrative ??
                                        (wording.has(entry.id)
                                          ? suggested
                                          : undefined) ??
                                        line.narrative
                                      }
                                      onChange={(event) =>
                                        editWording(
                                          entry.id,
                                          event.target.value,
                                        )
                                      }
                                    />
                                    {edits.has(entry.id) && (
                                      <button
                                        type="button"
                                        className="bo-invoice-link"
                                        onClick={() =>
                                          editWording(entry.id, undefined)
                                        }
                                      >
                                        {t("invoiceReview.reset_wording")}
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  line.narrative
                                )}
                              </td>
                              <td className="bo-billing-number">
                                {visibleDraft && previewLine
                                  ? money(
                                      previewLine.baseAmountMinor,
                                      visibleDraft.currency,
                                    )
                                  : "—"}
                              </td>
                              <td className="bo-billing-number">
                                {visibleDraft && previewLine
                                  ? money(
                                      previewLine.amountMinor,
                                      visibleDraft.currency,
                                    )
                                  : "—"}
                              </td>
                            </tr>
                          );
                        },
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="bo-view-toolbar">
                  <label>
                    {t("invoiceReview.reduction")}
                    <select
                      value={reduction}
                      onChange={(event) => {
                        setReduction(
                          event.target.value === "target" ||
                            event.target.value === "percent"
                            ? event.target.value
                            : "",
                        );
                        setAdjustmentValue("");
                      }}
                    >
                      <option value="">
                        {t("invoiceReview.no_reduction")}
                      </option>
                      <option value="percent">
                        {t("invoiceReview.percent")}
                      </option>
                      <option value="target">
                        {t("invoiceReview.target")}
                      </option>
                    </select>
                  </label>
                  {reduction && (
                    <>
                      <label>
                        {t("invoiceReview.reduce_scope")}
                        <select
                          value={scope}
                          onChange={(event) => {
                            setScope(
                              event.target.value === "entries" ||
                                event.target.value === "people"
                                ? event.target.value
                                : "all",
                            );
                            setScopeIds(new Set());
                          }}
                        >
                          <option value="all">
                            {t("invoiceReview.all_lines")}
                          </option>
                          <option value="people">
                            {t("invoiceReview.people")}
                          </option>
                          <option value="entries">
                            {t("invoiceReview.lines")}
                          </option>
                        </select>
                      </label>
                      {reduction === "target" && (
                        <label>
                          {t("invoiceReview.target_scope")}
                          <select
                            value={targetBasis}
                            onChange={(event) =>
                              setTargetBasis(
                                event.target.value === "invoice"
                                  ? "invoice"
                                  : "selection",
                              )
                            }
                          >
                            <option value="selection">
                              {t("invoiceReview.selected_target")}
                            </option>
                            <option value="invoice">
                              {t("invoiceReview.invoice_target")}
                            </option>
                          </select>
                        </label>
                      )}
                      <label>
                        {t(
                          reduction === "target"
                            ? "invoiceReview.target"
                            : "invoiceReview.percent",
                        )}
                        <input
                          inputMode="decimal"
                          value={adjustmentValue}
                          onChange={(event) =>
                            setAdjustmentValue(event.target.value)
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
                {reduction && scope !== "all" && (
                  <div className="bo-invoice-adjustment-choices">
                    {[...selectedScope].map((id) => (
                      <label key={id}>
                        <input
                          type="checkbox"
                          checked={scopeIds.has(id)}
                          onChange={(event) =>
                            setScopeIds(
                              updateCheck(scopeIds, id, event.target.checked),
                            )
                          }
                        />
                        {scope === "people"
                          ? (people.get(id) ?? id)
                          : included.find((entry) => entry.id === id)
                              ?.narrative}
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </fieldset>
      {included.length > 0 && (
        <div className="bo-billing-subrow">
          <Button
            size="sm"
            variant="outline"
            disabled={!input.success || pending || pendingAdjustments}
            onClick={() =>
              input.success &&
              void send({ type: "prepareInvoice", draft: input.data }).catch(
                () => {},
              )
            }
          >
            {t("back_office.billing.preview")}
          </Button>
          {pendingAdjustments && (
            <span>{t("back_office.billing.invoice_correction_pending")}</span>
          )}
        </div>
      )}
      {visibleDraft && (
        <div className="bo-invoice-draft-preview">
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
          <iframe
            className="bo-invoice-preview"
            title={t("timesheets.template_preview")}
            sandbox=""
            srcDoc={renderInvoice(visibleDraft.snapshot.template, {
              ...visibleDraft.snapshot,
              currency: visibleDraft.currency,
              billingMode: visibleDraft.input.pricing.mode,
              showHours: visibleDraft.showHours,
              entries: visibleDraft.lines.map(({ entry, amountMinor }) => ({
                ...entry,
                amountMinor,
              })),
            })}
          />
          {state.supportsInvoiceWordingReview &&
            models.length > 0 &&
            !visibleDraft.approval &&
            !visibleDraft.input.wording.length &&
            !visibleDraft.input.edits?.length && (
              <div className="bo-billing-subrow">
                <label>
                  {t("invoiceReview.model")}{" "}
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    disabled={pending}
                  >
                    <option value="">{t("invoiceReview.choose_model")}</option>
                    {models.map(
                      ({ workspaceId, providerID, modelID, label }) => {
                        const key = JSON.stringify([
                          workspaceId,
                          providerID,
                          modelID,
                        ]);
                        return (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        );
                      },
                    )}
                  </select>
                </label>
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
          <div className="bo-billing-subrow">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void download(visibleDraft, "docx")}
            >
              {t("invoiceReview.preview_docx")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void download(visibleDraft, "pdf")}
            >
              {t("invoiceReview.preview_pdf")}
            </Button>
            {visibleDraft.approval ? (
              <>
                <span role="status">{t("invoiceReview.approved")}</span>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => void issue(visibleDraft)}
                >
                  {t("back_office.billing.issue")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={pending || !visibleDraft.snapshot.clientAddress}
                onClick={() =>
                  void send({
                    type: "approveInvoice",
                    id: visibleDraft.id,
                    revision: visibleDraft.revision,
                  }).catch(() => {})
                }
              >
                {t("invoiceReview.approve")}
              </Button>
            )}
            {!visibleDraft.snapshot.clientAddress && (
              <span>{t("invoiceReview.address_required")}</span>
            )}
          </div>
        </div>
      )}
      {(error || downloadError) && (
        <p role="alert" className="bo-billing-error">
          {error || downloadError}
        </p>
      )}
    </div>
  );
}
