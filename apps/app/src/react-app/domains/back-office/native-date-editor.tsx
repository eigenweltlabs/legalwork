import { useState } from "react";
import { Button, Input, Checkbox } from "twenty-ui/primitives/input";
import { DatePicker } from "twenty-ui/components/input";
import { t } from "@/i18n";

function localTime(value: string) {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString();
}
export function NativeDateEditor({
  value,
  required,
  onSave,
  onCancel,
}: {
  value: string;
  required: boolean;
  onSave: (value: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const initial = localTime(value);
  const [day, setDay] = useState(initial.slice(0, 10));
  const [month, setMonth] = useState((initial || new Date().toISOString()).slice(0, 7));
  const [timed, setTimed] = useState(value.includes("T"));
  const [time, setTime] = useState(initial.slice(11, 19) || "09:00:00");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(date: string) {
    if (busy) return;
    setBusy(true);
    try {
      let next: string | null = date || null;
      if (date && timed) {
        const local = date + "T" + (time.length === 5 ? time + ":00" : time);
        next = !required || /(Z|[+-]\d{2}:\d{2})$/.test(value) ? new Date(local).toISOString() : local;
      }
      await onSave(next);
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("back_office.create.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="bo-cell-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(day);
      }}
    >
      <DatePicker
        value={day || null}
        viewedMonth={month}
        onViewedMonthChange={setMonth}
        onValueChange={setDay}
        onValueSelect={(date) => {
          setDay(date);
          if (!timed) void save(date);
        }}
        weekStart={1}
        locale={navigator.language}
        previousMonthLabel={t("calendar.previous")}
        nextMonthLabel={t("calendar.next")}
        monthLabel={t("calendar.month")}
        yearLabel={t("back_office.year")}
      />
      <label>
        <Checkbox checked={timed} onCheckedChange={(checked) => setTimed(Boolean(checked))} />
        {t("native.include_time")}
      </label>
      {timed && (
        <Input
          required
          type="time"
          step={1}
          aria-label={t("native.include_time")}
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <div className="bo-modal-footer">
        {!required && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save("")}>
            {t("tasks.due_clear")}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || !day}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
