import { currencyScale, timeFeeMinor } from "@legalwork/types/invoice-template";
import type { TimeEntry } from "@legalwork/types/timesheet";

export function feeTotals(entries: TimeEntry[]) {
  const totals = new Map<string, { minor: number; scale: number }>();
  let unresolved = 0;
  for (const { billableMinutes, hourlyRate, currency } of entries) {
    if (hourlyRate === undefined || !currency) {
      if (billableMinutes > 0) unresolved++;
      continue;
    }
    const total = totals.get(currency) ?? { minor: 0, scale: currencyScale(currency) };
    total.minor += timeFeeMinor(billableMinutes, hourlyRate, total.scale);
    totals.set(currency, total);
  }
  const byCurrency = new Map<string, number>();
  for (const [currency, { minor, scale }] of totals) byCurrency.set(currency, minor / scale);
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
