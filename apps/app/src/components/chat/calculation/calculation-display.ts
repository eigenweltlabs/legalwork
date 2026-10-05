import type { CalculationPresentation, CalculationRun } from "@legalwork/types/calculation";
import { currentLocale, t } from "@/i18n";

type Step = CalculationRun["steps"][number];
const regions: Record<string, string> = { BE: "Berlin", BW: "Baden-Württemberg", BY: "Bayern", BB: "Brandenburg", HB: "Bremen", HH: "Hamburg", HE: "Hessen", MV: "Mecklenburg-Vorpommern", NI: "Niedersachsen", NW: "Nordrhein-Westfalen", RP: "Rheinland-Pfalz", SL: "Saarland", SN: "Sachsen", ST: "Sachsen-Anhalt", SH: "Schleswig-Holstein", TH: "Thüringen" };
const factNames: Record<string, string> = { triggerDate: "calc.trigger", serviceDate: "calc.served", duration: "calc.duration", region: "calc.location", court: "calc.court", direction: "calc.direction", timeZone: "calc.timezone", serviceMethod: "calc.service_method", pronouncementDate: "calc.pronounced", extensionGrantedDate: "calc.extension", additionalHolidays: "calc.holidays", stateHolidays: "calc.holidays", courtClosedDates: "calc.closures", cutoffTime: "calc.cutoff" };
const hiddenFacts = new Set(["rule", "source", "unit", "timeZone", "triggerType", "id", "kennung", "calculationId", "runId", "codeHash", "version"]);
const noValue = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);

export function dateText(day: string, long = false) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(currentLocale(), { timeZone: "UTC", ...(long ? { month: "long" } : { weekday: "short", month: "short" }), day: "numeric", year: "numeric" });
}
export function readableText(text: string, timeZone?: string) {
  // Format recorded values only. No dates or legal decisions are recalculated here.
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, value => new Date(value).toLocaleString(currentLocale(), { timeZone, dateStyle: "medium", timeStyle: "short" }))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, value => dateText(value));
}
function factLabel(key: string) { return factNames[key] ? t(factNames[key]) : key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "); }
function valueText(value: unknown, key = "", timeZone?: string): string {
  if (noValue(value)) return "";
  if (typeof value === "boolean") return t(value ? "calc.yes" : "calc.no");
  if (Array.isArray(value)) return value.map(value => valueText(value, key, timeZone)).join(", ");
  if (typeof value === "object" && value) return Object.entries(value).filter(([, value]) => !noValue(value)).map(([key, value]) => `${factLabel(key)}: ${valueText(value, key, timeZone)}`).join(" · ");
  if (typeof value === "number" && /(?:timestamp|epoch)(?:_?ms)?$/i.test(key)) return new Date(value).toLocaleString(currentLocale(), { timeZone, dateStyle: "medium", timeStyle: "short" });
  if (key === "region" && typeof value === "string") return regions[value] ?? value;
  if (key === "direction" && value === "before") return t("calc.before");
  if (key === "serviceMethod") {
    switch (value) {
      case "personal": return t("calc.service_personal");
      case "electronic": return t("calc.service_electronic");
      case "mail": return t("calc.service_mail");
      case "clerk": return t("calc.service_clerk");
      case "consented-other": return t("calc.service_consented-other");
    }
  }
  return readableText(String(value), timeZone);
}
function periodText(count: unknown, unit: unknown) {
  if (typeof count !== "number") return valueText(count);
  switch (unit) {
    case "days": return count === 1 ? t("calc.period_days_one", { count }) : t("calc.period_days", { count });
    case "weeks": return count === 1 ? t("calc.period_weeks_one", { count }) : t("calc.period_weeks", { count });
    case "months": return count === 1 ? t("calc.period_months_one", { count }) : t("calc.period_months", { count });
    case "years": return count === 1 ? t("calc.period_years_one", { count }) : t("calc.period_years", { count });
    default: return valueText(count);
  }
}
export function calculationFacts(run: CalculationRun) {
  return Object.entries(run.inputs).filter(([key, value]) => !hiddenFacts.has(key) && !noValue(value)
    && !(key === "direction" && value === "after") && !(value === false && ["supplementaryJudgment", "specialRuleOrOrder"].includes(key)))
    .map(([key, value]) => ({ label: key === "triggerDate" && run.inputs.triggerType === "service" ? t("calc.served") : factLabel(key), value: key === "duration" ? periodText(value, run.inputs.unit) : valueText(value, key, run.results[0]?.timeZone) }));
}
export function calculationSteps(run: CalculationRun) {
  const shifted = run.steps.some(step => /^\d{4}-\d{2}-\d{2} (?:is not a working day|is nonworking|after the service addition is nonworking);/.test(step.reason));
  return run.steps.flatMap(step => {
    const zone = run.results[0]?.timeZone;
    // Known, versioned calculator messages become the compact rows from the design.
    // Every date below is captured from the executed trace, never inferred from inputs.
    let match = /^Start on (\d{4}-\d{2}-\d{2}), (excluding the event day|including the beginning day)/.exec(step.reason);
    if (match) return [{ title: t(match[2].startsWith("excluding") ? "calc.start_next" : "calc.start_same"), reason: t(match[2].startsWith("excluding") ? "calc.exclude_day" : "calc.include_day"), value: dateText(match[1]) }];
    match = /^(\d+) (days|weeks|months|years) from (\d{4}-\d{2}-\d{2}); nominal end (\d{4}-\d{2}-\d{2})/.exec(step.reason);
    if (match) return [{ title: t("calc.count_period"), reason: t("calc.count_from", { period: periodText(Number(match[1]), match[2]), date: dateText(match[3]) }), value: dateText(match[4]) }];
    match = /^Weekend and statutory-holiday check passed for (\d{4}-\d{2}-\d{2}) \(([^)]+)\)/.exec(step.reason);
    if (match) return [{ title: t("calc.check_endpoint"), reason: t("calc.working_day", { location: match[2].split(", ").map(part => regions[part] ?? part).join(", ") }), value: t(shifted ? "calc.endpoint_confirmed" : "calc.unchanged") }];
    match = /^(\d{4}-\d{2}-\d{2}) (?:is not a working day|is nonworking|after the service addition is nonworking);/.exec(step.reason);
    if (match) return [{ title: t("calc.adjust_endpoint"), reason: t("calc.nonworking_day", { date: dateText(match[1]) }), value: "" }];
    if (/^(End of day |Cutoff |Deadline day .*; cutoff )/.test(step.reason) && run.results.length) return []; // The exact cutoff is already visible in the result.
    return [{ title: /^\d+$/.test(step.title) ? "" : step.title, reason: readableText(step.reason, zone), value: stepValue(step, zone) }];
  });
}
function stepValue(step: Step, timeZone?: string) {
  // Unlabelled numeric intermediates (e.g. epoch arithmetic) are execution details,
  // not meaningful dates. The recorded reason and final dated result remain visible.
  return typeof step.output === "number" ? "" : valueText(step.output, "", timeZone);
}
export function cutoffText(result: CalculationRun["results"][number]) {
  const cutoff = new Date(result.cutoff);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: result.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(cutoff);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const nextDay = new Date(`${result.date}T00:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  if (`${fields.year}-${fields.month}-${fields.day}` === nextDay.toISOString().slice(0, 10) && fields.hour === "00" && fields.minute === "00" && fields.second === "00") return t("calc.end_of_day");
  return cutoff.toLocaleString(currentLocale(), { timeZone: result.timeZone, dateStyle: "medium", timeStyle: "short" });
}
export function calculationSources(sources: CalculationPresentation["sources"]) {
  const groups = new Map<string, CalculationPresentation["sources"]>();
  for (const source of sources) {
    const path = source.path.replace(/\\/g, "/").split("/").filter(part => part && part !== ".").join("/").normalize("NFC");
    const group = groups.get(path) ?? [];
    if (!group.some(item => item.hash === source.hash && item.page === source.page && item.quote === source.quote)) group.push(source);
    groups.set(path, group);
  }
  return [...groups].map(([path, sources]) => ({ path, name: path.split("/").at(-1)!, sources }));
}
