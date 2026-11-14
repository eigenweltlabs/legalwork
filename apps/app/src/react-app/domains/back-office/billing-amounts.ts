import type { TimeEntry } from "@legalwork/types/timesheet";

// Resolve fees in currency minor units before summing, as on a statement.
export function entryFee(entry: Pick<TimeEntry, "billableMinutes" | "hourlyRate" | "currency">) {
  if (entry.hourlyRate === undefined || !entry.currency) return undefined;
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency: entry.currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const scale = 10 ** digits;
  return {
    amount: Math.round((entry.billableMinutes * entry.hourlyRate * scale) / 60) / scale,
    currency: entry.currency,
  };
}

export function feeTotals(entries: TimeEntry[]) {
  const byCurrency = new Map<string, number>();
  let unresolved = 0;
  for (const entry of entries) {
    const fee = entryFee(entry);
    if (fee) byCurrency.set(fee.currency, (byCurrency.get(fee.currency) ?? 0) + fee.amount);
    else if (entry.billableMinutes > 0) unresolved++;
  }
  return { byCurrency, unresolved };
}

export function formatFee(locale: string, amount: number, currency: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

export function reviewPeriod(today = new Date()) {
  const dateText = (d: Date) =>
    [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  const start = new Date(today);
  start.setDate(today.getDate() - 20);
  return { from: dateText(start), to: dateText(today) };
}
