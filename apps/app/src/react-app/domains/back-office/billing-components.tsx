import { useRef, useState } from "react";
import type { TimeEntry, TimesheetCommand, TimesheetState } from "@legalwork/types/timesheet";
import { currentLocale, t } from "@/i18n";
import { feeTotals, formatFee } from "./billing-amounts";

export type BillingProps = {
  state: TimesheetState;
  onCommand: (command: TimesheetCommand) => Promise<unknown>;
};
export function feeSummary(rows: TimeEntry[]) {
  const { byCurrency, unresolved } = feeTotals(rows);
  const figures = [...byCurrency].map(([currency, value]) =>
    formatFee(currentLocale(), value, currency),
  );
  if (unresolved) figures.push(t("back_office.billing.unpriced", { count: unresolved }));
  return figures.join(" · ") || "–";
}
export function useBillingAction(onCommand: BillingProps["onCommand"]) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function send(command: TimesheetCommand) {
    if (busy.current) throw new Error(t("back_office.billing.saving"));
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await onCommand(command);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("back_office.billing.save_failed"));
      throw error;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { send, pending, error };
}

export function BillingOptions({ options }: { options: readonly { id: string; name: string }[] }) {
  return options.map((item) => (
    <option key={item.id} value={item.id}>
      {item.name}
    </option>
  ));
}
