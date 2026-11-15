import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { List, Sparkles, ListChecks, Settings2, Timer } from "lucide-react";

import {
  proposedCharge,
  resolveTimePolicy,
  TimesheetStateSchema,
  type TimesheetCommand,
  type TimeDraft,
} from "@legalwork/types/timesheet";
import { CalendarDaySchema } from "@legalwork/types/calendar";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { t } from "@/i18n";
import {
  isLoopbackLegalworkServerUrl,
  LegalworkServerError,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { calendarClientScope } from "../calendar/calendar-cache";
import type { BackOfficeState } from "./api";
import { timeRoutes } from "./time-routes";
import { TimesheetStopwatch } from "./timesheet-stopwatch";
import { TimesheetLedger } from "./timesheet-ledger";
import { BillingReview } from "./billing-review";
import { BillingPreferences } from "./billing-preferences";
import { TimesheetWorkday } from "./timesheet-workday";

type SelectedProposal = {
  key: string;
  entry: Partial<TimeDraft>;
  proposalDigest: string;
  source: "suggestion";
};
export function TimesheetWorkspace({
  client,
  directory,
  page,
}: {
  client: LegalworkServerClient;
  directory: BackOfficeState;
  page: keyof typeof timeRoutes;
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
    const project = state.projects.find((x) => x.id === p.projectId);
    const matter = p.matterId
      ? state.matters.find((x) => x.id === p.matterId)
      : project?.matterIds.length === 1
        ? state.matters.find((x) => x.id === project.matterIds[0])
        : undefined;
    const billTo = matter?.clientIds.length === 1 ? matter.clientIds[0] : undefined;
    const charge =
      p.workedMinutes && billTo && matter
        ? proposedCharge(
            p.workedMinutes,
            resolveTimePolicy(state.policies, billTo, matter.id, p.date, project?.id),
          )
        : undefined;
    setProposal({
      key: p.key,
      source: "suggestion",
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
    { id: "timesheets", label: t("timesheets.mine"), Icon: List },
    { id: "timesheet-workday", label: t("timesheets.ai_tab"), Icon: Sparkles },
    { id: "billing-review", label: t("timesheets.review"), Icon: ListChecks },
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
            .filter(({ id }) => id !== "billing-review" || state?.canReview || state?.canManage)
            .map(({ id, label, Icon }) => (
              <Link
                key={id}
                to={timeRoutes[id] + (initialDate ? "?date=" + initialDate : "")}
                aria-current={page === id ? "page" : undefined}
              >
                <Icon size={15} />
                {label}
              </Link>
            ))}
        </nav>
        {directory.captureProfileId && isLoopbackLegalworkServerUrl(client.baseUrl) && (
          <TimesheetStopwatch client={client} profileId={directory.captureProfileId} />
        )}
      </header>
      {query.isError && (
        <div className="bo-empty" role="alert">
          {team && query.error instanceof LegalworkServerError && [404, 501, 502].includes(query.error.status)
            ? t("timesheets.hosted_unavailable")
            : query.error.message}{" "}
          <button type="button" onClick={() => void query.refetch()}>
            {t("timesheets.retry")}
          </button>
        </div>
      )}
      {!query.isError && !state && <div className="bo-loading">{t("timesheets.loading")}</div>}
      {state && (page === "timesheets" || ledgerDirty) && (
        <div className="time-ledger-pane" hidden={page !== "timesheets"}>
          <TimesheetLedger
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
          />
        </div>
      )}
      {state && page === "billing-review" && (
        <BillingReview
          canEdit={directory.permissions.edit}
          initialDate={initialDate}
          client={client}
          state={state}
          onCommand={send}
        />
      )}
      {state && page === "billing-settings" && (
        <BillingPreferences
          state={state}
          onCommand={send}
          initialProjectId={params.get("project") ?? undefined}
          initialMatterId={
            !params.has("directory") || params.get("directory") === directory.directoryId
              ? (params.get("matter") ?? undefined)
              : undefined
          }
          initialClientId={params.get("client") ?? undefined}
        />
      )}
      {state && page === "timesheet-workday" && (
        <TimesheetWorkday
          initialDate={initialDate}
          onDateChange={selectDate}
          client={client}
          directory={directory}
          state={state}
          ledgerDirty={ledgerDirty}
          onDraft={draft}
        />
      )}
    </>
  );
}
