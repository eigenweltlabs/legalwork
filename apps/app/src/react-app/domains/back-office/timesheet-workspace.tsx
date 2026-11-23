import { useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { calendarDay } from "../calendar/calendar-format";
import type { TimePeriod } from "./timesheet-row";
import { Button as AppButton } from "@/components/ui/button";

import {
  TimesheetStateSchema,
  type TimesheetCommand,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { CalendarDaySchema } from "@legalwork/types/calendar";
import type { PrivateBookingRevision, WorkdayModelOption } from "@legalwork/types/time-capture";
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
import { BillingPreferences } from "./billing-preferences";
import { TimesheetWorkday } from "./timesheet-workday";
import type { SaveBackOfficeView } from "./record-grid";
import { TimeRecordSheet } from "./time-record-sheet";
import { TimeWorkflowProposal } from "./time-workflow-proposal";
import { BackOfficeSurface } from "./twenty-controls";
import { TimeSetting, TimeSettingsGroup } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";

export function TimesheetWorkspace({
  client,
  directory,
  page,
  renderRecords, onSaveView,
  workdayModels,
  directoryRefresh,
}: {
  client: LegalworkServerClient;
  directory: BackOfficeState;
  page: keyof typeof timeRoutes;
  workdayModels?: WorkdayModelOption[];
  directoryRefresh?: { error: Error; retry: () => void; fetching: boolean };
  onSaveView: SaveBackOfficeView;
  renderRecords: (objectId: "timeEntries" | "invoices") => ReactNode;
}) {
  const [params, setParams] = useSearchParams(),
    cache = useQueryClient();
  const location = useLocation();
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
    const state = TimesheetStateSchema.parse(
      await client.backOffice("/timesheet?" + identity, {
        team,
        timeoutMs: command?.type === "reviewInvoiceWording" ? 600_000 : command?.type === "issueInvoice" ? 90_000 : undefined,
        ...(command ? { method: "POST", body: command } : {}),
      }),
    );
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
  const canOpenInvoices = state && (recordsOnly ? directory.permissions.finance : state.canReview || state.canManage);
  const invoices = canOpenInvoices && state ? (
    recordsOnly ? renderRecords("invoices") : <BackOfficeSurface>
      <BillingReview canEdit={directory.permissions.edit} initialDate={initialDate} initialMode={page === "billing-review" ? "submitted" : "invoices"}
        initialMatterId={!params.has("directory") || params.get("directory") === directory.directoryId ? params.get("matter") ?? "" : ""}
        workdayModels={workdayModels} client={client} state={state} onCommand={send} />
    </BackOfficeSurface>
  ) : undefined;
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
            invoices={invoices} requestedTab={page === "billing-review" && canOpenInvoices ? "invoices" : location.state?.timeWorkspaceTab === "entries" ? "entries" : undefined}>
            {(capture, workspace) => recordsOnly
              ? <TimeRecordSheet onSaveView={onSaveView} client={client} directory={directory} state={state} capture={capture} workspace={workspace} />
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
      {page === "billing-settings" && isLoopbackLegalworkServerUrl(client.baseUrl) && (
        <div className="py-2">
          <AppButton size="sm" variant="outline" nativeButton={false} render={<Link to={"/settings/time-tracking" + (params.size ? "?" + params : "")} />}>
            {t("timeWorkspace.guidelines")}<ArrowUpRight size={14} />
          </AppButton>
        </div>
      )}
      {recordsOnly && page === "billing-settings" && (
        <section className="w-full min-w-0 py-4" aria-label={t("timesheets.settings")}>
          <LayoutStack>
            <TimeSettingsGroup title={t("timesheets.records_settings_title")}>
              <TimeSetting title={t("back_office.feeAgreements.plural")} description={t("timesheets.records_agreements_hint")}>
                <AppButton size="sm" variant="outline" nativeButton={false} role="link" render={<Link to="/back-office/feeAgreements" />}>
                  {t("timesheets.records_agreements_open")}<ArrowUpRight size={14} />
                </AppButton>
              </TimeSetting>
              <TimeSetting title={t("timesheets.records_workflow_title")} description={t("timesheets.records_settings")}>
                <span className="text-xs text-muted-foreground">{t("timesheets.records_unavailable")}</span>
              </TimeSetting>
            </TimeSettingsGroup>
          </LayoutStack>
        </section>
      )}
      {state && !recordsOnly && page === "billing-settings" && (
        <BackOfficeSurface>
          <BillingPreferences
            accountScope={JSON.stringify([directory.directoryId, directory.captureProfileId, directory.scope, principalKey, userId])}
            previewWord={template => client.previewBillingTemplate(template,state.scope)}
            key={[params.get("project"), params.get("matter"), params.get("client"), params.get("date")].join("/")}
            initialDate={initialDate}
            state={state}
            onCommand={send}
            initialProjectId={params.get("project") ?? undefined}
            initialMatterId={
              !params.has("directory") || params.get("directory") === directory.directoryId
                ? (params.get("matter") ?? undefined)
                : undefined
            }
            initialClientId={
              !params.has("directory") || params.get("directory") === directory.directoryId
                ? (params.get("client") ?? undefined)
                : undefined
            }
          />
        </BackOfficeSurface>
      )}

    </>
  );
}
