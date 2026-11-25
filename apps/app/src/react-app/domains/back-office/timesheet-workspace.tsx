import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ClipboardCheck, FileText, SlidersHorizontal } from "lucide-react";
import { calendarDay } from "../calendar/calendar-format";
import { periodDates, type TimePeriod } from "./timesheet-row";
import { Button as AppButton } from "@/components/ui/button";

import {
  assignedTimeReviewer, resolveTimePolicy, TimesheetStateSchema,
  type TimesheetCommand,
  type TimeInvoice,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { CalendarDaySchema } from "@legalwork/types/calendar";
import type { PrivateBookingRevision } from "@legalwork/types/time-capture";
import { t } from "@/i18n";
import {
  isLoopbackLegalworkServerUrl,
  LegalworkServerError,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { calendarClientScope } from "../calendar/calendar-cache";
import { backOfficeReadFailure, isBackOfficeAccessError, type BackOfficeReadFailure, type BackOfficeState } from "./api";
import { timeRoutes } from "./time-routes";
import { TimesheetLedger } from "./timesheet-ledger";
import { BillingReview } from "./billing-review";
import { RecordHistorySidebar } from "./history-panel";
import { FirmTimeReview } from "./firm-time-review";
import { BillingGuidelinesSettings } from "./billing-guidelines-settings";
import { BillingPreferences } from "./billing-preferences";
import { TimesheetWorkday } from "./timesheet-workday";
import type { SaveBackOfficeView } from "./record-grid";
import { TimeRecordSheet } from "./time-record-sheet";
import { TimeWorkflowProposal } from "./time-workflow-proposal";
import { BackOfficeSurface } from "./twenty-controls";
import { TimeSetting, TimeSettingsGroup } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";
import { HubTabs } from "../settings/segmented-tabs";

export type InvoiceRegister = { scope: string; userId: string; invoices: readonly TimeInvoice[] };

export function TimesheetWorkspace({
  client,
  directory,
  page,
  renderRecords, onSaveView,
  directoryRefresh,
}: {
  client: LegalworkServerClient;
  directory: BackOfficeState;
  page: keyof typeof timeRoutes;
  directoryRefresh?: { error: Error; retry: () => void; fetching: boolean };
  onSaveView: SaveBackOfficeView;
  renderRecords: (objectId: "timeEntries" | "invoices", invoiceRegister?: InvoiceRegister) => ReactNode;
}) {
  const [params, setParams] = useSearchParams(),
    cache = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const { userId, principalKey, replicaId } = directory.permissions;
  const team = directory.scope !== "local";
  const key = [
    "back-office",
    ...calendarClientScope(client),
    "timesheet",
    directory.scope,
    directory.directoryId,
    directory.captureProfileId,
    userId,
    principalKey,
    replicaId,
    directory.permissions.edit,
    directory.permissions.model,
    directory.permissions.finance,
  ];
  const initialDate = CalendarDaySchema.safeParse(params.get("date")).data;
  const date = initialDate ?? calendarDay(new Date());
  const requestedPeriod = params.get("range");
  const period = requestedPeriod === "month" || requestedPeriod === "week" ? requestedPeriod : "day";
  function selectPeriod(nextDate: string, nextPeriod: TimePeriod = period) {
    if (nextDate === date && nextPeriod === period) return;
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("date", nextDate);
      if (nextPeriod === "day") next.delete("range");
      else next.set("range", nextPeriod);
      return next;
    });
  }
  async function request(command?: TimesheetCommand, draft?: PrivateBookingRevision) {
    const identity = new URLSearchParams({ expectedUserId: userId });
    if (directory.directoryId) identity.set("directoryId", directory.directoryId);
    if (principalKey) identity.set("expectedPrincipalKey", principalKey);
    if (directory.captureProfileId && command?.type === "create" && (command.source === "suggestion" || draft))
      identity.set("profileId", directory.captureProfileId);
    if (draft) {
      identity.set("draftDate", draft.date);
      identity.set("draftRevision", String(draft.revision));
    }
    const fetchState = () => client.backOffice("/timesheet?" + identity, {
      team,
      ...(command ? { method: "POST", body: command } : {}),
    });
    const result = await fetchState().catch(error => {
      // A directory refresh may retire the read cache during polling.
      if (!command && error instanceof LegalworkServerError && error.code === "back_office_replica_changed") return fetchState();
      throw error;
    });
    const state = TimesheetStateSchema.parse(result);
    if (state.userId !== userId || state.scope !== directory.scope)
      throw new LegalworkServerError(409, "back_office_account_changed", t("timesheets.account_changed"));
    return state;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try { return await request(); }
      catch (error) { return backOfficeReadFailure(error); }
    },
    retry: false,
    refetchInterval: 30000,
  });
  const [dateLocked, setDateLocked] = useState(false);
  const outcome = query.data;
  const blocked = outcome && "loadError" in outcome ? outcome.loadError : undefined;
  const state = outcome && "entries" in outcome ? outcome : undefined;
  const timesheetError = query.error ?? blocked;
  const loadError = timesheetError ?? directoryRefresh?.error;
  const recordsOnly = state?.service === "records";
  const firmReview = team && state?.service === "workflow";
  const recordsGrid = team || recordsOnly;
  const queryFilter = { queryKey: key, exact: true };
  async function send(command: TimesheetCommand, draft?: PrivateBookingRevision) {
    const activeQuery = cache.getQueryCache().find(queryFilter);
    const isCurrent = () => activeQuery && cache.getQueryCache().find(queryFilter) === activeQuery;
    try {
      const next = await request(command, draft);
      if (!isCurrent()) throw new Error(t("timesheets.account_changed"));
      await cache.cancelQueries(queryFilter);
      if (!isCurrent()) throw new Error(t("timesheets.account_changed"));
      const latest = cache.getQueryData<TimesheetState | BackOfficeReadFailure>(key);
      if (latest && "loadError" in latest) throw latest.loadError;
      cache.setQueryData(key, next);
      if (command.type === "createInvoice")
        void cache.invalidateQueries({ queryKey: ["back-office", client.baseUrl, "auto"] });
      return next;
    } catch (error) {
      if (isCurrent() && isBackOfficeAccessError(error)) {
        await cache.cancelQueries(queryFilter);
        if (isCurrent()) cache.setQueryData(key, backOfficeReadFailure(error));
      }
      if (isCurrent()) void query.refetch();
      throw error;
    }
  }
  const workdayScope = JSON.stringify([...calendarClientScope(client), directory.directoryId,
    directory.scope, principalKey, userId, directory.captureProfileId]);
  const timekeepingPage = page !== "billing-settings";
  const localBilling = !timekeepingPage && isLoopbackLegalworkServerUrl(client.baseUrl);
  const requestedBillingTab = params.get("tab");
  const billingTab = localBilling && requestedBillingTab === "guidelines" ? "guidelines"
    : requestedBillingTab === "review" ? "review" : "rules";
  const matchesBillingDirectory = !params.has("directory") || params.get("directory") === directory.directoryId;
  const billingMatterId = matchesBillingDirectory ? params.get("matter") ?? undefined : undefined;
  const billingClientId = matchesBillingDirectory ? params.get("client") ?? undefined : undefined;

  const canOpenInvoices = state && (team || recordsOnly ? directory.permissions.finance : state.canReview || state.canManage);
  const invoices = canOpenInvoices && state ? (
    recordsOnly ? renderRecords("invoices") : <BackOfficeSurface>
      <BillingReview invoiceViews={team} canEdit={directory.permissions.edit} initialDate={initialDate} initialMode={!team && page === "billing-review" ? "submitted" : "invoices"}
        directory={directory} columnScope={workdayScope + ":unbilled"} onSaveView={onSaveView}
        invoiceRegister={renderRecords("invoices", { scope: state.scope, userId: state.userId, invoices: state.invoices })}
        initialMatterId={!params.has("directory") || params.get("directory") === directory.directoryId ? params.get("matter") ?? "" : ""}
        renderRecordHistory={team ? (entry, close) => <RecordHistorySidebar key={entry.id}
          client={client} directory={directory} record={entry} onClose={close}
          onOpen={record => navigate("/back-office/" + record.objectId + "?record=" + encodeURIComponent(record.id))} /> : undefined}
        client={client} state={state} onCommand={send} />
    </BackOfficeSurface>
  ) : undefined;
  const review = firmReview && state?.canReview ? <FirmTimeReview client={client} state={state} directory={directory}
    reviewEntryId={page === "billing-review" ? params.get("reviewEntry") : null}
    dates={periodDates(date, period)} onCommand={send} columnScope={workdayScope + ":review"} onSaveView={onSaveView} /> : undefined;
  const requestedTab = page === "billing-review" ? (review ? "review" : !team && invoices ? "invoices" : "entries")
    : location.state?.timeWorkspaceTab === "entries" ? "entries" : undefined;
  const submit = !firmReview ? undefined : async (ids: readonly string[]) => {
    await client.backOffice("/sync", { team: true, method: "POST", body: {} });
    const latest = await request();
    const idSet = new Set(ids);
    const entries = latest.entries.filter(entry => idSet.has(entry.id) && entry.workerId === userId && entry.status === "confirmed" &&
      assignedTimeReviewer(resolveTimePolicy(latest.policies, entry.clientId, entry.matterId, entry.date, entry.projectId), entry.workerId));
    if (!entries.length || entries.length !== idSet.size) throw new Error(t("back_office.conflict.title"));
    await send({ type: "submit", entries: entries.map(({ id, revision }) => ({ id, revision })) });
  };
  return (
    <>
      {loadError && (
        <div className={state ? "mx-4 my-2 flex shrink-0 flex-wrap items-center gap-2 text-sm" : "bo-empty"} role="alert">
          {loadError.message}{" "}
          <AppButton size="sm" variant="outline" disabled={query.isFetching || directoryRefresh?.fetching} onClick={() => {
            if (timesheetError) void query.refetch();
            directoryRefresh?.retry();
          }}>
            {t("timesheets.retry")}
          </AppButton>
        </div>
      )}
      {!loadError && !state && <div className="bo-loading">{t("timesheets.loading")}</div>}
      {!recordsOnly && !!state?.unresolvedLegacyEntries?.length && (page === "timesheets" || page === "timesheet-workday") && (
        <details className="mx-4 mb-2 max-h-[30vh] shrink-0 overflow-auto rounded-md border px-3 py-2 text-sm">
          <summary>{t("timesheets.legacy_timekeeper")}</summary>
          <p className="mt-2 text-muted-foreground">{t("timesheets.legacy_timekeeper_help")}</p>
          <ul className="mt-2 space-y-1">
            {state.unresolvedLegacyEntries.map(id => <li key={id}>
              <Link className="underline" to={"/back-office/timeEntries?record=" + encodeURIComponent(id)}>
                {String(directory.records.find(record => record.id === id)?.values.name ?? t("back_office.timeEntries.singular"))}
              </Link>
            </li>)}
          </ul>
        </details>
      )}
      {state && timekeepingPage && (
        <div className="time-ledger-pane">
          <TimesheetWorkday key={workdayScope} visible={timekeepingPage} dateLocked={dateLocked}
            client={client} directory={directory} state={state} initialDate={date} initialPeriod={period} onDateChange={selectPeriod}
            invoices={invoices} review={review} requestedTab={requestedTab}>
            {(capture, workspace) => recordsGrid
              ? <TimeRecordSheet onSaveView={onSaveView} client={client} directory={directory} state={state} capture={capture} workspace={workspace}
                  firmCommand={firmReview ? send : undefined} submit={submit}
                  reviewLink={review && page !== "billing-review" ? timeRoutes["billing-review"] + "?" + params : undefined} />
              : workspace(
                <TimesheetLedger visible={timekeepingPage} capture={capture}
                  onOriginal={isLoopbackLegalworkServerUrl(client.baseUrl) ? digest =>
                    client.privateWorkdayOriginal(digest, {
                      scope: directory.scope, user: userId, principal: principalKey ?? "",
                      ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
                    }) : undefined}
                  canEdit={directory.permissions.edit} state={state} onCommand={send} columnScope={workdayScope}
                  onEditingChange={(_, locked) => setDateLocked(locked)} initialDate={date} onDateChange={selectPeriod} />,
                proposal => <TimeWorkflowProposal key={proposal.digest} proposal={proposal} state={state}
                  capture={capture} onCommand={send} canEdit={directory.permissions.edit} />,
                undefined, { save: async (requestId, entry) => { await send({ type: "create", requestId, entry, workerIds: [userId] }); } },
              )}
          </TimesheetWorkday>
        </div>
      )}
      {!timekeepingPage && <LayoutStack>
        <HubTabs<"rules" | "review" | "guidelines">
          label={t("timesheets.settings")} value={billingTab}
          items={[
            { id: "rules", label: t("back_office.billing.time_rules"), icon: SlidersHorizontal },
            { id: "review", label: t("back_office.billing.detail"), icon: ClipboardCheck },
            ...(localBilling ? [{ id: "guidelines" as const, label: t("timeWorkspace.guidelines"), icon: FileText }] : []),
          ]}
          onChange={tab => {
            if (tab === billingTab) return;
            setParams(previous => {
              const next = new URLSearchParams(previous);
              if (tab === "rules") next.delete("tab");
              else next.set("tab", tab);
              return next;
            });
          }}
        />
        {state && billingTab === "guidelines" && (
          <BillingGuidelinesSettings client={client} directory={directory} state={state} date={date}
            matterId={billingMatterId} clientId={billingClientId} />
        )}
        {recordsOnly && billingTab === "rules" && (
          <TimeSettingsGroup title={t("timesheets.records_settings_title")}>
            <TimeSetting title={t("back_office.feeAgreements.plural")} description={t("timesheets.records_agreements_hint")}>
              <AppButton size="sm" variant="outline" nativeButton={false} role="link" render={<Link to="/back-office/feeAgreements" />}>
                {t("timesheets.records_agreements_open")}<ArrowUpRight size={14} />
              </AppButton>
            </TimeSetting>
            <TimeSetting title={t("back_office.billing.time_rules")} description={t("timesheets.records_settings")}>
              <span className="text-xs text-muted-foreground">{t("timesheets.records_unavailable")}</span>
            </TimeSetting>
          </TimeSettingsGroup>
        )}
        {recordsOnly && billingTab === "review" && (
          <TimeSettingsGroup>
            <TimeSetting title={t("timesheets.review_assignment")} description={t("timesheets.records_review_settings")}>
              <span className="text-xs text-muted-foreground">{t("timesheets.records_unavailable")}</span>
            </TimeSetting>
          </TimeSettingsGroup>
        )}
        {state && !recordsOnly && (billingTab === "rules" || billingTab === "review") && (
          <BillingPreferences
            accountScope={JSON.stringify([directory.directoryId, directory.captureProfileId, directory.scope, principalKey, userId])}
            key={[params.get("project"), billingMatterId, billingClientId, initialDate].join("/")}
            initialDate={initialDate}
            section={billingTab}
            state={state}
            onCommand={send}
            initialProjectId={params.get("project") ?? undefined}
            initialMatterId={billingMatterId}
            initialClientId={billingClientId}
          />
        )}
      </LayoutStack>}

    </>
  );
}
