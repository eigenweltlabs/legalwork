import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CaptureAction } from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { calendarClientScope } from "../calendar/calendar-cache";
import type { BackOfficeState } from "./api";
import { TimeWorkspaceGuidelines } from "./time-workspace-guidelines";

export function BillingGuidelinesSettings({ client, directory, state, date, matterId, clientId }: {
  client: LegalworkServerClient;
  directory: BackOfficeState;
  state: TimesheetState;
  date: string;
  matterId?: string;
  clientId?: string;
}) {
  const cache = useQueryClient();
  const identity = {
    scope: directory.scope,
    user: directory.permissions.userId,
    principal: directory.permissions.principalKey ?? "",
    ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
  };
  const scopeKey = ["back-office", ...calendarClientScope(client), "workday", directory.directoryId, identity];
  const dayKey = [...scopeKey, "day", date];
  const input = { ...identity, date };
  const day = useQuery({
    queryKey: dayKey,
    queryFn: ({ signal }) => client.privateWorkday(input, undefined, signal),
    retry: false,
  });
  const update = useMutation({
    mutationFn: async (action: Extract<CaptureAction, { type: "guideline" }>) => {
      const result = await client.privateWorkday(input, action);
      return { result, scopeKey, dayKey };
    },
    onSuccess: async ({ result, scopeKey, dayKey }) => {
      await cache.cancelQueries({ queryKey: scopeKey });
      cache.setQueryData(dayKey, result);
      await cache.invalidateQueries({ queryKey: scopeKey });
    },
  });

  if (day.error) return <p role="alert">{day.error.message}</p>;
  if (!day.data) return <p role="status">{t("timesheets.loading")}</p>;

  const matter = state.matters.find(item => item.id === matterId);
  const customer = state.clients.find(item => item.id === clientId);
  const initialTarget = matter ? { scope: "matter" as const, targetId: matter.id }
    : customer ? { scope: "client" as const, targetId: customer.id } : undefined;

  return <>
    <TimeWorkspaceGuidelines
      key={JSON.stringify([initialTarget, date])} initialTarget={initialTarget}
      date={date} guidelines={day.data.guidelines} state={state} pending={update.isPending}
      save={async action => { try { await update.mutateAsync(action); return true; } catch { return false; } }}
      extractRules={(text, signal) => client.privateGuidelineRules(input, text, undefined, signal)}
      readPdf={(file, signal) => client.privateGuidelineText(input, file, signal)}
    />
    {update.error && <p role="alert">{update.error.message}</p>}
  </>;
}
