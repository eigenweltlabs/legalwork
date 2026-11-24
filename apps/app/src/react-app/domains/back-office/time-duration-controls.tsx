import { useState, useSyncExternalStore, type ComponentProps } from "react";
import { Dropdown } from "twenty-ui/components/navigation";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { formatTimeDuration, parseTimeDuration, type TimeDurationFormat } from "./time-duration";

const key = "legalwork.timekeeping.duration-format";
const changed = "legalwork-time-duration-format";
let sessionFormat: TimeDurationFormat | undefined;
function read(): TimeDurationFormat {
  if (sessionFormat) return sessionFormat;
  try { return window.localStorage.getItem(key) === "minutes" ? "minutes" : "hours"; }
  catch { return sessionFormat ?? "hours"; }
}
function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener("storage", listener); };
}
export function useTimeDurationFormat() {
  return useSyncExternalStore<TimeDurationFormat>(subscribe, read, () => "hours");
}
function choose(format: TimeDurationFormat) {
  try { window.localStorage.setItem(key, format); sessionFormat = undefined; }
  catch { sessionFormat = format; }
  window.dispatchEvent(new Event(changed));
}

export function TimeDurationOptions() {
  const format = useTimeDurationFormat();
  return <>
    <Dropdown.Header><Dropdown.Title>{t("timeWorkspace.durationFormat")}</Dropdown.Title></Dropdown.Header>
    <Dropdown.OptionItem value="hours" indicator="check" selected={format === "hours"} closeOnSelect={false} onSelect={() => choose("hours")}>{t("timeWorkspace.durationHours")}</Dropdown.OptionItem>
    <Dropdown.OptionItem value="minutes" indicator="check" selected={format === "minutes"} closeOnSelect={false} onSelect={() => choose("minutes")}>{t("timeWorkspace.durationMinutes")}</Dropdown.OptionItem>
    <Dropdown.Separator />
  </>;
}

/** Keep the typed shorthand until blur; callers continue working with minute strings. */
export function TimeEntryInput({ value, duration = true, unstyled, onValueChange, onBlur, ...props }: Omit<ComponentProps<"input">, "value" | "onChange"> & {
  value: string; duration?: boolean; unstyled?: boolean; onValueChange: (value: string) => void;
}) {
  const format = useTimeDurationFormat();
  const [typed, setTyped] = useState<{ raw: string; minutes: string; format: TimeDurationFormat }>();
  const display = value === "" || !Number.isFinite(Number(value)) ? value : formatTimeDuration(Number(value), format);
  const text = duration ? typed?.minutes === value && typed.format === format ? typed.raw : display : value;
  const Component = unstyled ? "input" : Input;
  return <Component {...props} type={duration ? "text" : props.type} inputMode={duration ? "numeric" : props.inputMode}
    placeholder={duration ? format === "hours" ? "0:00" : "0" : props.placeholder}
    aria-invalid={duration && value !== "" && !Number.isFinite(Number(value)) ? true : props["aria-invalid"]}
    value={text} onChange={event => {
      const raw = event.currentTarget.value;
      if (!duration) { onValueChange(raw); return; }
      let minutes: string;
      try { minutes = String(parseTimeDuration(raw, format) ?? ""); }
      catch { minutes = raw.includes(":") ? raw : /^\d+$/.test(raw) ? raw.slice(0, -2) + ":" + raw.slice(-2) : raw + ":"; }
      setTyped({ raw, minutes, format });
      onValueChange(minutes);
    }} onBlur={event => { setTyped(undefined); onBlur?.(event); }} />;
}
