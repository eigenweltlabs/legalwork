import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, List, ListChecks, Settings2, Timer } from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Button as AppButton } from "@/components/ui/button";

import {
  proposedCharge,
  proposedStopwatchCharge,
  resolveTimePolicy,
  TimesheetStateSchema,
  type TimesheetCommand,
  type TimeDraft,
} from "@legalwork/types/timesheet";
import { CalendarDaySchema } from "@legalwork/types/calendar";
import { captureChargeMinutes, type CaptureProposal, type WorkdayModelOption } from "@legalwork/types/time-capture";
import { t } from "@/i18n";
import {
  isLoopbackLegalworkServerUrl,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { calendarClientScope } from "../calendar/calendar-cache";
import type { BackOfficeState } from "./api";
import { timeRoutes } from "./time-routes";
import { TimesheetLedger } from "./timesheet-ledger";
import { BillingReview } from "./billing-review";
import { BillingPreferences } from "./billing-preferences";
import { TimesheetWorkday } from "./timesheet-workday";
import { TimeRecordSheet } from "./time-record-sheet";
import { TimeSetting, TimeSettingsGroup } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";

type SelectedProposal = {
  key: string;
  entry: Partial<TimeDraft>;
  proposalDigest: string;
  source: "suggestion";
  captureSource: CaptureProposal["source"];
};
export function TimesheetWorkspace({
  client,
  directory,
  page,
  renderRecords,
  workdayModels,
}: {
  client: LegalworkServerClient;
  directory: BackOfficeState;
  page: keyof typeof timeRoutes;
  workdayModels?: WorkdayModelOption[];
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
    if (
      directory.captureProfileId &&
      ((command?.type === "create" && command.source === "suggestion") ||
        (command?.type === "submit" && command.entries.some((e) => e.shareOriginal)))
    )
      identity.set("profileId", directory.captureProfileId);
    const state = TimesheetStateSchema.parse(
      await client.backOffice("/timesheet?" + identity, {
        team,
        ...(command ? { method: "POST", body: command } : {}),
      }),
    );
    if (state.userId !== userId) throw new Error(t("timesheets.account_changed"));
    return state;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: () => request(),
    retry: false,
    refetchInterval: 30000,
  });
  const [proposal, setProposal] = useState<SelectedProposal>();
  const [ledgerDirty, setLedgerDirty] = useState(false);
  const state = query.isError ? undefined : query.data;
  const recordsOnly = state?.service === "records";
  async function send(command: TimesheetCommand) {
    try {
      const next = await request(command);
      await cache.cancelQueries({ queryKey: key, exact: true });
      cache.setQueryData(key, next);
      if (command.type === "create" && command.source === "suggestion") setProposal(undefined);
      return next;
    } catch (error) {
      void query.refetch();
      throw error;
    }
  }
  const draft = (p: CaptureProposal) => {
    if (!state) return;
    if (recordsOnly) return;
    const project = state.projects.find((x) => x.id === p.projectId);
    const matter = p.matterId
      ? state.matters.find((x) => x.id === p.matterId)
      : project?.matterIds.length === 1
        ? state.matters.find((x) => x.id === project.matterIds[0])
        : undefined;
    const billTo = matter?.clientIds.length === 1 ? matter.clientIds[0] : undefined;
    const minutes = captureChargeMinutes(p);
    const policy = resolveTimePolicy(state.policies, billTo ?? "", matter?.id ?? "", p.date, project?.id);
    const charge = minutes === null ? undefined
      : p.source === "stopwatch" ? proposedStopwatchCharge(minutes, policy)
      : billTo && matter ? proposedCharge(minutes, policy) : undefined;
    setProposal({
      key: p.key,
      source: "suggestion",
      captureSource: p.source,
      proposalDigest: p.digest,
      entry: {
        date: p.date,
        activity: p.activity,
        narrative: p.source === "stopwatch" && !p.parentDigest ? "" : p.narrative,
        ...(project ? { projectId: project.id } : {}),
        ...(matter
          ? { matterId: matter.id, clientId: matter.clientIds.length === 1 ? matter.clientIds[0] : "" }
          : {}),
        ...(p.workedMinutes ? { workedMinutes: p.workedMinutes } : {}),
        ...(charge !== undefined ? { billableMinutes: charge } : {}),
        ...(p.startAt && p.endAt ? { startAt: p.startAt, endAt: p.endAt } : {}),
      },
    });
  };
  const tabs = [
    { id: "timesheets", label: t(recordsOnly ? "back_office.timeEntries.plural" : "timesheets.mine"), Icon: List },
    { id: "billing-review", label: t(recordsOnly ? "back_office.invoices.plural" : "timesheets.review"), Icon: ListChecks },
    { id: "billing-settings", label: t("timesheets.settings"), Icon: Settings2 },
  ] as const;
  return (
    <>
      <header className="time-section-header">
        <h1>
          <Timer size={19} />
          {t("timesheets.workspace_title")}
        </h1>
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
      {query.isError && (
        <div className="bo-empty" role="alert">
          {query.error.message}{" "}
          <AppButton size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("timesheets.retry")}
          </AppButton>
        </div>
      )}
      {!query.isError && !state && <div className="bo-loading">{t("timesheets.loading")}</div>}
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
      {state && !recordsOnly && (page === "timesheets" || page === "timesheet-workday" || ledgerDirty) && (
        <div className="time-ledger-pane" hidden={page !== "timesheets" && page !== "timesheet-workday"}>
          <TimesheetWorkday visible={page === "timesheets" || page === "timesheet-workday"} ledgerDirty={ledgerDirty} models={workdayModels} client={client} directory={directory} state={state} initialDate={initialDate} onDateChange={selectDate} onDraft={draft}>
          {capture => <TimesheetLedger visible={page === "timesheets" || page === "timesheet-workday"}
            capture={capture}
            onOriginal={
              isLoopbackLegalworkServerUrl(client.baseUrl)
                ? (digest) =>
                    client.privateWorkdayOriginal(digest, {
                      scope: directory.scope,
                      user: userId,
                      principal: principalKey ?? "",
                      ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
                    })
                : undefined
            }
            canEdit={directory.permissions.edit}
            state={state}
            onCommand={send}
            columnScope={JSON.stringify([
              client.baseUrl,
              directory.directoryId,
              directory.scope,
              principalKey,
              userId,
            ])}
            onEditingChange={setLedgerDirty}
            onDateChange={selectDate}
            initialDate={initialDate}
            onDiscardProposal={() => setProposal(undefined)}
            initialDraft={proposal}
          />}
          </TimesheetWorkday>
        </div>
      )}
      {state && recordsOnly && (page === "timesheets" || page === "timesheet-workday") && (
        <TimesheetWorkday models={workdayModels} client={client} directory={directory} state={state} initialDate={initialDate} onDateChange={selectDate} onDraft={draft}>
          {capture => <TimeRecordSheet client={client} directory={directory} state={state} capture={capture} />}
        </TimesheetWorkday>
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
          client={client}
          state={state}
          onCommand={send}
        />
      )}
      {state && !recordsOnly && page === "billing-settings" && (
        <BillingPreferences
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
