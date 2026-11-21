import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, List, ListChecks, Settings2 } from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Button as AppButton } from "@/components/ui/button";

import {
  TimesheetStateSchema,
  type TimesheetCommand,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { CalendarDaySchema } from "@legalwork/types/calendar";
import type { WorkdayModelOption } from "@legalwork/types/time-capture";
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
import { TimeRecordSheet } from "./time-record-sheet";
import { TimeWorkflowProposal } from "./time-workflow-proposal";
import { TimeSetting, TimeSettingsGroup } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";

export function TimesheetWorkspace({
  client,
  directory,
  page,
  renderRecords,
  workdayModels,
  directoryRefresh,
}: {
  client: LegalworkServerClient;
  directory: BackOfficeState;
  page: keyof typeof timeRoutes;
  workdayModels?: WorkdayModelOption[];
  directoryRefresh?: { error: Error; retry: () => void; fetching: boolean };
  renderRecords: (objectId: "timeEntries" | "invoices") => ReactNode;
}) {
  const [params, setParams] = useSearchParams(),
    cache = useQueryClient();
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
  function selectDate(date: string) {
    if (date === initialDate) return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("date", date);
        return next;
      },
      { replace: true },
    );
  }
  async function request(command?: TimesheetCommand) {
    const identity = new URLSearchParams({ expectedUserId: userId });
    if (directory.directoryId) identity.set("directoryId", directory.directoryId);
    if (principalKey) identity.set("expectedPrincipalKey", principalKey);
    if (directory.captureProfileId && command?.type === "create" && command.source === "suggestion")
      identity.set("profileId", directory.captureProfileId);
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
  const [{ dirty: ledgerDirty, dateLocked }, setLedgerEditing] = useState({ dirty: false, dateLocked: false });
  const outcome = query.data;
  const blocked = outcome && "loadError" in outcome ? outcome.loadError : undefined;
  const state = outcome && "entries" in outcome ? outcome : undefined;
  const timesheetError = query.error ?? blocked;
  const loadError = timesheetError ?? directoryRefresh?.error;
  const recordsOnly = state?.service === "records";
  const queryFilter = { queryKey: key, exact: true };
  async function send(command: TimesheetCommand) {
    const activeQuery = cache.getQueryCache().find(queryFilter);
    const isCurrent = () => activeQuery && cache.getQueryCache().find(queryFilter) === activeQuery;
    try {
      const next = await request(command);
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
  const timekeepingPage = page === "timesheets" || page === "timesheet-workday";
  const tabs = [
    { id: "timesheets", label: t(recordsOnly ? "back_office.timeEntries.plural" : "timesheets.mine"), Icon: List },
    { id: "billing-review", label: t(recordsOnly ? "back_office.invoices.plural" : "timesheets.review"), Icon: ListChecks },
    { id: "billing-settings", label: t("timesheets.settings"), Icon: Settings2 },
  ] as const;
  return (
    <>
      <header className="time-section-header">
        <nav aria-label={t("timesheets.workspace_title")}>
          {tabs
            .filter(({ id }) => id !== "billing-review" || state?.canReview || state?.canManage || (recordsOnly && directory.permissions.finance))
            .map(({ id, label, Icon }) => (
              <Button
                key={id}
                size="sm"
                variant={page === id || (page === "timesheet-workday" && id === "timesheets") ? "soft" : "ghost"}
                nativeButton={false}
                role="link"
                render={<Link to={timeRoutes[id] + (initialDate ? "?date=" + initialDate : "")} />}
                startIcon={<Icon size={15} />}
                aria-current={page === id || (page === "timesheet-workday" && id === "timesheets") ? "page" : undefined}
              >
                {label}
              </Button>
            ))}
        </nav>
      </header>
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
      {state && (timekeepingPage || ledgerDirty) && (
        <div className="time-ledger-pane" hidden={!timekeepingPage}>
          <TimesheetWorkday key={workdayScope} visible={timekeepingPage} dateLocked={dateLocked} models={workdayModels}
            client={client} directory={directory} state={state} initialDate={initialDate} onDateChange={selectDate}>
            {(capture, workspace) => recordsOnly
              ? <TimeRecordSheet client={client} directory={directory} state={state} capture={capture} workspace={workspace} />
              : workspace(
                <TimesheetLedger visible={timekeepingPage} capture={capture}
                  onOriginal={isLoopbackLegalworkServerUrl(client.baseUrl) ? digest =>
                    client.privateWorkdayOriginal(digest, {
                      scope: directory.scope, user: userId, principal: principalKey ?? "",
                      ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
                    }) : undefined}
                  canEdit={directory.permissions.edit} state={state} onCommand={send} columnScope={workdayScope}
                  onEditingChange={(dirty, dateLocked) => setLedgerEditing(previous =>
                    previous.dirty === dirty && previous.dateLocked === dateLocked ? previous : { dirty, dateLocked })} initialDate={initialDate} onDateChange={selectDate} />,
                proposal => <TimeWorkflowProposal key={proposal.digest} proposal={proposal} state={state}
                  capture={capture} onCommand={send} canEdit={directory.permissions.edit} />,
              )}
          </TimesheetWorkday>
        </div>
      )}
      {recordsOnly && page === "billing-review" && directory.permissions.finance && <>
        <p className="mx-4 my-2 text-sm text-muted-foreground">{t("timesheets.invoice_records_hint")}</p>
        {renderRecords("invoices")}
      </>}
      {recordsOnly && page === "billing-settings" && (
        <section className="time-record-settings" aria-label={t("timesheets.settings")}>
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
      {state && !recordsOnly && page === "billing-review" && (
        <BillingReview
          canEdit={directory.permissions.edit}
          initialDate={initialDate}
          initialMatterId={!params.has("directory") || params.get("directory") === directory.directoryId ? params.get("matter") ?? "" : ""}
          workdayModels={workdayModels}
          client={client}
          state={state}
          onCommand={send}
        />
      )}
      {state && !recordsOnly && page === "billing-settings" && (
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
      )}

    </>
  );
}
