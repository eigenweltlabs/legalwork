import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Dropdown } from "twenty-ui/components/navigation";
import { Button } from "twenty-ui/primitives/input";
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
import { DirectoryMenu } from "./twenty-controls";
import { TimesheetLedger } from "./timesheet-ledger";
import { BillingReview } from "./billing-review";
import { BillingPreferences } from "./billing-preferences";
import { TimesheetWorkday } from "./timesheet-workday";

export function isTimesheetPage(page: string) {
  return ["timesheets", "billing-review", "billing-settings", "timesheet-workday"].includes(page);
}
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
  page: string;
}) {
  const [params] = useSearchParams(),
    cache = useQueryClient(),
    navigate = useNavigate();
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
  const identity = new URLSearchParams({ expectedUserId: userId });
  if (directory.directoryId) identity.set("directoryId", directory.directoryId);
  if (principalKey) identity.set("expectedPrincipalKey", principalKey);
  async function request(command?: TimesheetCommand) {
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
  const [menu, setMenu] = useState(false),
    [proposal, setProposal] = useState<SelectedProposal>();
  const state = query.data;
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
        narrative: p.narrative,
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
  if (query.isError)
    return (
      <div className="bo-empty" role="alert">
        {team &&
        query.error instanceof LegalworkServerError &&
        [404, 501, 502].includes(query.error.status)
          ? t("timesheets.hosted_unavailable")
          : query.error.message}{" "}
        <button type="button" onClick={() => void query.refetch()}>
          {t("timesheets.retry")}
        </button>
      </div>
    );
  if (!state) return <div className="bo-loading">{t("timesheets.loading")}</div>;
  const titles: Record<string, string> = {
    timesheets: t("timesheets.mine"),
    "timesheet-workday": t("timesheets.workday"),
    "billing-review": t("timesheets.review"),
    "billing-settings": t("timesheets.settings"),
  };
  const available = [
    "timesheets",
    "timesheet-workday",
    ...(state.canReview || state.canManage ? ["billing-review"] : []),
    "billing-settings",
  ];
  return (
    <>
      <header className="bo-object-header">
        <DirectoryMenu
          open={menu}
          onOpenChange={setMenu}
          trigger={
            <Button size="sm" endIcon={<ChevronDown size={14} />}>
              {titles[page]}
            </Button>
          }
        >
          {available.map((id) => (
            <Dropdown.ActionItem
              key={id}
              onClick={() => {
                setMenu(false);
                navigate("/back-office/" + id);
              }}
            >
              {titles[id]}
            </Dropdown.ActionItem>
          ))}
        </DirectoryMenu>
        {page === "timesheets" && (
          <Link className="bo-time-secondary" to="/back-office/timesheet-workday">
            {t("timesheets.workday")}
          </Link>
        )}
      </header>
      {page === "timesheets" && (
        <TimesheetLedger
          onOriginal={
            isLoopbackLegalworkServerUrl(client.baseUrl)
              ? (digest) =>
                  client.privateWorkdayOriginal(digest, {
                    scope: directory.scope,
                    user: userId,
                    principal: principalKey ?? "",
                  })
              : undefined
          }
          canEdit={directory.permissions.edit}
          state={state}
          onCommand={send}
          initialDate={initialDate}
          initialDraft={proposal}
        />
      )}
      {page === "billing-review" && (
        <BillingReview initialDate={initialDate} client={client} state={state} onCommand={send} />
      )}
      {page === "billing-settings" && (
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
      {page === "timesheet-workday" && (
        <TimesheetWorkday
          initialDate={initialDate}
          client={client}
          directory={directory}
          state={state}
          onDraft={draft}
        />
      )}
    </>
  );
}
