import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Play, Square } from "lucide-react";
import { t } from "@/i18n";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarClientScope } from "../calendar/calendar-cache";

export function TimesheetStopwatch({
  client,
  profileId,
}: {
  client: LegalworkServerClient;
  profileId: string;
}) {
  const cache = useQueryClient();
  const scope = calendarClientScope(client);
  const key = ["private-stopwatch", ...scope, profileId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => client.privateStopwatch(undefined, profileId),
    retry: false,
    refetchInterval: 5000,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [savedDay, setSavedDay] = useState("");
  const lastSeen = useRef<string | undefined>(undefined);
  const stoppedId = query.data?.lastStopped?.id;
  useEffect(() => {
    if (stoppedId && stoppedId !== lastSeen.current) {
      lastSeen.current = stoppedId;
      void cache.invalidateQueries({ queryKey: ["back-office", ...calendarClientScope(client), "workday"] });
    }
  }, [stoppedId, cache, client]);
  const [now, setNow] = useState(Date.now);
  const active = query.data?.active;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [active?.startedAt]);
  const seconds = active ? Math.max(0, Math.floor((now - Date.parse(active.startedAt)) / 1000)) : 0;
  async function toggle() {
    if (!query.data || pending) return;
    setSavedDay("");
    setPending(true);
    setError("");
    try {
      await cache.cancelQueries({ queryKey: key, exact: true });
      const next = await client.privateStopwatch(
        active ? { type: "stop", id: active.id } : { type: "start", id: crypto.randomUUID() },
        profileId,
      );
      cache.setQueryData(key, next);
      if (active && next.lastStopped?.id === active.id) setSavedDay(next.lastStopped.date);
    } catch {
      setError(t("timesheets.timer_failed"));
      void query.refetch();
    } finally {
      setPending(false);
    }
  }
  const title = query.isError
    ? t("timesheets.timer_offline")
    : active
      ? t("timesheets.timer_stop")
      : t("timesheets.timer_start");
  return (
    <div className="time-stopwatch">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={!!active}
        disabled={!query.data || pending || query.isError}
        onClick={() => void toggle()}
      >
        {active ? <Square size={12} fill="currentColor" /> : <Play size={13} />}
        <span>
          {active
            ? [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
                .map((n) => String(n).padStart(2, "0"))
                .join(":")
            : t("timesheets.source.stopwatch")}
        </span>
      </button>
      {savedDay && !active && (
        <Link
          className="time-stopwatch-saved"
          to={"/time/workday?date=" + savedDay}
          onClick={() => setSavedDay("")}
        >
          {t("timesheets.timer_saved")}
        </Link>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
