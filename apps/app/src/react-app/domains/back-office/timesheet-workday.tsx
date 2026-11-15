import { sourceKeys } from "./timesheet-labels";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CalendarDays, Settings2, Sparkles } from "lucide-react";
import { TimeSelect, TimeSetting, TimeSettingsGroup, TimeSwitch } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
  captureEnabled,
  sameCaptureAccount,
  type CaptureAction,
  type CaptureProposal,
} from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { t, currentLocale } from "@/i18n";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarDay } from "../calendar/calendar-format";
import { calendarClientScope } from "../calendar/calendar-cache";
import type { BackOfficeState } from "./api";
import { overlappingWorkdayRanges, WorkdayCorrectionForm, WorkdayTimeline } from "./timesheet-workday-view";
import "./timesheet-workday.css";

const at = (instant: string) =>
  new Date(instant).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
export function TimesheetWorkday({
  client,
  directory,
  state,
  onDraft,
  ledgerDirty = false,
  initialDate,
  onDateChange,
}: {
  initialDate?: string;
  onDateChange?: (value: string) => void;
  client: LegalworkServerClient;
  directory: BackOfficeState;
  state: TimesheetState;
  ledgerDirty?: boolean;
  onDraft: (p: CaptureProposal) => void;
}) {
  const [editing, setEditing] = useState("");
  const [date, setDate] = useState(() => initialDate ?? calendarDay(new Date())),
    [error, setError] = useState(""),
    [running, setRunning] = useState(false);
  const navigate = useNavigate(),
    cache = useQueryClient();
  useEffect(() => {
    if (initialDate) setDate(initialDate);
  }, [initialDate]);
  const local = isLoopbackLegalworkServerUrl(client.baseUrl);
  const context = {
    date,
    scope: directory.scope,
    user: directory.permissions.userId,
    principal: directory.permissions.principalKey ?? "",
    ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
  };
  const key = ["back-office", ...calendarClientScope(client), "workday", context];
  const query = useQuery({
    queryKey: key,
    queryFn: () => client.privateWorkday(context),
    enabled: local,
    retry: false,
    refetchInterval: 60000,
  });
  const profileId = directory.captureProfileId;
  const { data: lastStoppedId } = useQuery({
    queryKey: ["private-stopwatch", ...calendarClientScope(client), profileId],
    queryFn: () => client.privateStopwatch(undefined, profileId),
    select: (status) => status.lastStopped?.id,
    enabled: local && Boolean(profileId),
    retry: false,
    refetchInterval: 5000,
  });
  const refetchWorkday = query.refetch;
  useEffect(() => {
    if (local && profileId && lastStoppedId) void refetchWorkday();
  }, [local, profileId, lastStoppedId, refetchWorkday]);
  async function act(action: CaptureAction) {
    setError("");
    setRunning(true);
    try {
      const next = await client.privateWorkday(context, action);
      await cache.cancelQueries({ queryKey: key, exact: true });
      cache.setQueryData(key, next);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("timesheets.unavailable"));
      return false;
    } finally {
      setRunning(false);
    }
  }
  if (!local) return <div className="bo-empty">{t("timesheets.local_only")}</div>;
  const data = query.data,
    settings = data?.settings,
    shown =
      data?.proposals.filter(
        (p) =>
          !state.entries.some(
            (e) =>
              (e.groupId === p.key ||
                e.proposalDigest === p.digest ||
                (e.proposalDigest && p.versions?.includes(e.proposalDigest))) &&
              e.workerId === context.user,
          ),
      ) ?? [];
  const selected = shown.find((p) => p.key === editing);
  const ownEntries = state.entries.filter(
    (e) =>
      e.workerId === context.user &&
      e.date === date &&
      ["confirmed", "submitted", "approved", "invoiced"].includes(e.status),
  );
  const overlaps = overlappingWorkdayRanges(shown, ownEntries);
  return (
    <section className="bo-workday">
      <div className="bo-workday-controls">
        <label>
          <CalendarDays size={14} />
          <input
            type="date"
            aria-label={t("timesheets.date")}
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setDate(e.target.value);
                onDateChange?.(e.target.value);
              }
            }}
          />
        </label>
        <Button
          size="sm"
          disabled={running || !settings || !captureEnabled(settings)}
          variant="outline"
          onClick={() => void act({ type: "calendar" })}
        >
          {t("timesheets.read_sources")}
        </Button>
        <Button
          size="sm"
          title={data?.modelReady ? undefined : t("timesheets.no_model")}
          disabled={running || !data?.modelReady || !settings || !captureEnabled(settings)}
          onClick={() => void act({ type: "run" })}
        >
          <Sparkles size={14} />
          {t("timesheets.run_local")}
        </Button>
      </div>
      {settings && (
        <details open={!captureEnabled(settings) || undefined}>
          <summary>
            <Settings2 size={14} />
            {t("timesheets.sources")}
          </summary>
          <LayoutStack className="mt-3">
            <TimeSettingsGroup>
              {(["calendar", "tasks", "documents"] as const).map((source) => {
                const label = t(sourceKeys[source]);
                return (
                  <TimeSwitch
                    key={source}
                    label={label}
                    checked={Boolean(settings[source])}
                    disabled={running}
                    onChange={(checked) =>
                      void act({ type: "settings", settings: { ...settings, [source]: checked } })
                    }
                  />
                );
              })}
              {data?.connections.map((account) => {
                const enabled =
                  settings.connections?.some((item) => sameCaptureAccount(item, account)) ?? false;
                return (
                  <TimeSwitch
                    key={account.provider + account.account}
                    label={t(sourceKeys[account.provider])}
                    disabled={running}
                    checked={enabled}
                    onChange={(checked) => {
                      const others = (settings.connections ?? []).filter(
                        (item) => !sameCaptureAccount(item, account),
                      );
                      void act({
                        type: "settings",
                        settings: {
                          ...settings,
                          connections: checked ? [...others, account] : others,
                        },
                      });
                    }}
                  />
                );
              })}
              <TimeSetting title={<label htmlFor="time-source-schedule">{t("timesheets.schedule")}</label>}>
                <TimeSelect
                  id="time-source-schedule"
                  label={t("timesheets.schedule")}
                  disabled={running || !data?.modelReady}
                  value={String(settings.intervalMinutes)}
                  options={[
                    { id: "0", name: t("timesheets.on_demand") },
                    ...[15, 30, 60].map((n) => ({ id: String(n), name: n + " min" })),
                  ]}
                  onChange={(value) => {
                    const interval = Number(value);
                    if (interval === 0 || interval === 15 || interval === 30 || interval === 60)
                      void act({ type: "settings", settings: { ...settings, intervalMinutes: interval } });
                  }}
                />
              </TimeSetting>
            </TimeSettingsGroup>
          </LayoutStack>
          <p>{t("timesheets.connector_context")}</p>
          {!data?.modelReady && <p>{t("timesheets.no_model")}</p>}
        </details>
      )}
      {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
      {running && <p role="status">{t("timesheets.preparing")}</p>}
      {data && (
        <WorkdayTimeline
          date={date}
          proposals={shown}
          state={state}
          confirmed={ownEntries}
          onOpen={(p) => setEditing(p.key)}
        />
      )}
      {selected && (
        <WorkdayCorrectionForm
          key={selected.digest}
          proposal={selected}
          state={state}
          pending={running}
          save={act}
          close={() => setEditing("")}
        />
      )}
      {data && (
        <div className="bo-workday-list">
          {!shown.length ? (
            <p>{t("timesheets.no_proposals")}</p>
          ) : (
            shown.map((p) => (
              <div className="bo-workday-row" key={p.key}>
                <time>
                  {p.startAt ? at(p.startAt) : t("timesheets.workday.no_clock")}
                  {p.endAt && " – " + at(p.endAt)}
                </time>
                <span>
                  {p.source === "stopwatch" && !p.parentDigest
                    ? t("timesheets.source.stopwatch")
                    : p.narrative}
                  {overlaps.has(p.key) && <small>{t("timesheets.workday.overlap")}</small>}
                  {(p.source !== "stopwatch" || p.parentDigest) && <small>{t(sourceKeys[p.source])}</small>}
                </span>
                <div>
                  <Button size="sm" variant="ghost" disabled={running} onClick={() => setEditing(p.key)}>
                    {t("timesheets.workday.correct")}
                  </Button>
                  <Button
                    size="sm"
                    title={ledgerDirty ? t("timesheets.ledger.finish_edit") : undefined}
                    disabled={
                      !directory.permissions.edit ||
                      ledgerDirty ||
                      running ||
                      !!selected ||
                      (overlaps.has(p.key) && !p.parentDigest)
                    }
                    onClick={() => {
                      onDraft(p);
                      navigate("/time?date=" + p.date);
                    }}
                  >
                    {t("timesheets.prepare_draft")}
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running}
                  onClick={() => void act({ type: "dismiss", key: p.key })}
                >
                  {t("timesheets.dismiss")}
                </Button>
              </div>
            ))
          )}
        </div>
      )}
      {data && ownEntries.some((e) => !e.startAt || !e.endAt) && (
        <details>
          <summary>{t("timesheets.workday.booked_without_clock")}</summary>
          {ownEntries
            .filter((e) => !e.startAt || !e.endAt)
            .map((e) => (
              <p key={e.id}>
                {e.workedMinutes} min · {e.narrative}
              </p>
            ))}
        </details>
      )}
    </section>
  );
}
