import { useState, type FormEvent } from "react";
import { Button } from "twenty-ui/primitives/input";
import {
  adjustedTimeEntry,
  type TimeAdjustment,
  type TimeEntry,
  type TimesheetCommand,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";

export function AdjustmentRequest({
  entry,
  adjustments,
  submit,
}: {
  entry: TimeEntry;
  adjustments: TimeAdjustment[];
  submit: (command: TimesheetCommand) => Promise<boolean>;
}) {
  const current = adjustedTimeEntry(entry, adjustments);
  const [open, setOpen] = useState(false),
    [narrative, setNarrative] = useState(current.narrative),
    [minutes, setMinutes] = useState(String(current.billableMinutes)),
    [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [working, setWorking] = useState(false);
  const pending = adjustments.find((a) => a.entryId === entry.id && a.status === "pending");
  if (pending)
    return (
      <p className="bo-time-original">
        {t("timesheets.adjust.pending", { minutes: pending.toMinutes, reason: pending.reason })}
      </p>
    );
  async function send(event: FormEvent) {
    event.preventDefault();
    if (working || !reason.trim() || !narrative.trim() || !/^\d+$/.test(minutes)) return;
    setWorking(true);
    try {
      if (
        await submit({
          type: "adjust",
          requestId,
          id: entry.id,
          revision: entry.revision,
          reason: reason.trim(),
          narrative: narrative.trim(),
          billableMinutes: +minutes,
        })
      ) {
        setOpen(false);
        setRequestId(crypto.randomUUID());
        setReason("");
      }
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="bo-time-original">
      {open ? (
        <form className="bo-workday-correction" onSubmit={send}>
          <label>
            {t("timesheets.ledger.narrative")}
            <input
              required
              maxLength={2000}
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
            />
          </label>
          <label>
            {t("timesheets.ledger.charge")}
            <input
              type="number"
              required
              min="0"
              max="1440"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <label>
            {t("timesheets.adjust.reason")}
            <input
              required
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            disabled={
              working ||
              !reason.trim() ||
              (narrative.trim() === current.narrative && +minutes === current.billableMinutes)
            }
          >
            {t("timesheets.adjust.submit")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t("timesheets.workday.cancel")}
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setNarrative(current.narrative);
            setMinutes(String(current.billableMinutes));
            setOpen(true);
          }}
        >
          {t("timesheets.adjust.open")}
        </Button>
      )}
    </div>
  );
}
