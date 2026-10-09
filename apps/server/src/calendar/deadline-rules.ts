import { z } from "zod";
import { ApiError } from "../errors.js";
import { addDays, dayDate, dayOf, weekday, zonedInstant, zoneValid } from "./dates.js";

export const DEADLINE_RULE_VERSION = "2026.10.04.1";
const deSource = "https://www.gesetze-im-internet.de/";
export const DEADLINE_SKILLS = [
  { name: "de-civil-deadlines", jurisdiction: "DE", rules: ["de-zpo-period", "de-bgb-event", "de-bgb-beginning", "de-zpo-517", "de-zpo-520"], timeZone: "Europe/Berlin",
    sources: [`${deSource}bgb/__187.html`, `${deSource}bgb/__188.html`, `${deSource}bgb/__193.html`, `${deSource}zpo/__222.html`, `${deSource}zpo/__517.html`, `${deSource}zpo/__520.html`, "https://www.gesetze-bayern.de/Content/Document/BayFTG/true", "https://gesetze.berlin.de/bsbe/document/jlr-FeiertGBEV9P1"] },
  { name: "ew-civil-deadlines", jurisdiction: "GB-EW", rules: ["ew-cpr-clear-days"], timeZone: "Europe/London",
    sources: ["https://www.justice.gov.uk/courts/procedure-rules/civil/rules/part02", "https://www.legislation.gov.uk/uksi/2025/893/pdfs/uksi_20250893_en.pdf", "https://www.gov.uk/bank-holidays"] },
  { name: "us-federal-civil-deadlines", jurisdiction: "US-FED", rules: ["us-frcp-6-days"], timeZone: null,
    sources: ["https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf", "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/"] },
];

export const DeadlineInputSchema = z.strictObject({
  rule: z.string().min(1), triggerDate: z.iso.date(), duration: z.number().int().min(1).max(3650).optional(),
  unit: z.enum(["days", "weeks", "months", "years"]).optional(),
  direction: z.enum(["after", "before"]).default("after"),
  timeZone: z.string().max(100).optional(), region: z.string().max(100).optional(),
  municipality: z.string().max(200).optional(), catholicMunicipality: z.boolean().optional(),
  localCorpusChristi: z.boolean().optional(),
  appliesFinalDayAdjustment: z.boolean().optional(),
  pronouncementDate: z.iso.date().optional(), judgmentComplete: z.boolean().optional(),
  supplementaryJudgment: z.boolean().default(false),
  extensionGrantedDate: z.iso.date().optional(), extensionSource: z.string().max(4000).optional(),
  filing: z.enum(["electronic", "court-office", "service"]).optional(), cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  triggerType: z.enum(["event", "service"]).optional(), endIsEvent: z.boolean().optional(),
  serviceMethod: z.enum(["electronic", "personal", "mail", "clerk", "consented-other"]).optional(),
  additionalHolidays: z.array(z.iso.date()).max(1000).default([]),
  holidaySource: z.string().max(4000).optional(), court: z.string().max(255).optional(),
  courtCalendarConfirmed: z.boolean().optional(), stateHolidays: z.array(z.iso.date()).max(1000).default([]), courtClosedDates: z.array(z.iso.date()).max(1000).default([]),
  specialRuleOrOrder: z.boolean().default(false), source: z.string().min(1).max(4000),
});
export type DeadlineInput = z.infer<typeof DeadlineInputSchema>;
export type DeadlineResult = { skill: string; version: string; rule: string; input: DeadlineInput; deadlineDay: string; cutoff: string; timeZone: string; trace: string[]; sources: string[] };

function refuse(code: "missing_inputs" | "unsupported_rule" | "unsupported_scenario" | "outside_coverage", text: string): never { throw new ApiError(422, code, text); }
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) refuse("missing_inputs", `Provide ${name} from the user or source evidence.`); return value;
}
function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = (h + l - 7 * m + 114) % 31 + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function yearChecked(day: string): number {
  const year = dayDate(day).getUTCFullYear();
  if (year < 2020 || year > 2035) refuse("outside_coverage", "The installed holiday rules cover 2020–2035 only."); return year;
}
function holidayDate(year: number, md: string): string { return `${year}-${md}`; }
function deHoliday(day: string, input: DeadlineInput): boolean {
  const year = yearChecked(day), region = required(input.region, "the German Bundesland code"), md = day.slice(5), e = easter(year);
  if (!["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"].includes(region)) refuse("outside_coverage", "Unknown German Bundesland.");
  if (["01-01", "05-01", "10-03", "12-25", "12-26"].includes(md) || [-2, 1, 39, 50].some(n => addDays(e, n) === day)) return true;
  if (md === "01-06" && ["BW", "BY", "ST"].includes(region)) return true;
  if (region === "BE" && (["2020-05-08", "2025-05-08", "2028-06-17"].includes(day))) return true;
  if (md === "03-08" && (region === "BE" || (region === "MV" && year >= 2023))) return true;
  if (day === addDays(e, 60)) {
    if (["BW", "BY", "HE", "NW", "RP", "SL"].includes(region)) return true;
    if (["SN", "TH"].includes(region)) return required(input.localCorpusChristi, "whether Corpus Christi is a statutory holiday at this municipality");
  }
  if (region === "BY" && md === "08-08") {
    const municipality = required(input.municipality, "the court/receiving municipality"); return municipality.trim().toLowerCase() === "augsburg";
  }
  if (md === "08-15") {
    if (region === "SL") return true;
    if (region === "BY") { required(input.municipality, "the municipality"); return required(input.catholicMunicipality, "the official Assumption Day municipality classification for this year"); }
  }
  if (md === "09-20" && region === "TH") return true;
  if (md === "10-31" && ["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"].includes(region)) return true;
  if (md === "11-01" && ["BW", "BY", "NW", "RP", "SL"].includes(region)) return true;
  if (region === "SN") {
    let repentance = `${year}-11-22`; while (weekday(repentance) !== 3) repentance = addDays(repentance, -1);
    if (day === repentance) return true;
  }
  return false;
}
function nthWeekday(year: number, month: number, day: number, nth: number): string {
  let result = `${year}-${String(month).padStart(2, "0")}-01`; while (weekday(result) !== day) result = addDays(result, 1);
  return addDays(result, (nth - 1) * 7);
}
function lastWeekday(year: number, month: number, day: number): string {
  let result = dayOf(new Date(Date.UTC(year, month, 0))); while (weekday(result) !== day) result = addDays(result, -1); return result;
}
function observed(day: string): string { return weekday(day) === 6 ? addDays(day, -1) : weekday(day) === 0 ? addDays(day, 1) : day; }
function ukHolidays(year: number): Set<string> {
  const dates = new Set([`${year}-01-01`, addDays(easter(year), -2), addDays(easter(year), 1), nthWeekday(year, 5, 1, 1), lastWeekday(year, 5, 1), lastWeekday(year, 8, 1), `${year}-12-25`, `${year}-12-26`]);
  for (const md of ["01-01", "12-25", "12-26"]) {
    const date = `${year}-${md}`; if (![0, 6].includes(weekday(date))) continue;
    let substitute = addDays(date, 1); while ([0, 6].includes(weekday(substitute)) || dates.has(substitute)) substitute = addDays(substitute, 1); dates.add(substitute);
  }
  if (year === 2020) { dates.delete(nthWeekday(year, 5, 1, 1)); dates.add("2020-05-08"); }
  if (year === 2022) { dates.delete(lastWeekday(year, 5, 1)); ["2022-06-02", "2022-06-03", "2022-09-19"].forEach(d => dates.add(d)); }
  if (year === 2023) dates.add("2023-05-08"); return dates;
}
function usHolidays(year: number): Set<string> {
  const dates = new Set([nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), lastWeekday(year, 5, 1), nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2), nthWeekday(year, 11, 4, 4)]);
  for (const md of ["01-01", "07-04", "11-11", "12-25", ...(year >= 2021 ? ["06-19"] : [])]) {
    const day = `${year}-${md}`; dates.add(day); dates.add(observed(day));
  }
  dates.add(observed(`${year + 1}-01-01`)); return dates;
}
function nonworking(day: string, input: DeadlineInput, jurisdiction: string): boolean {
  const year = yearChecked(day);
  if ([0, 6].includes(weekday(day)) || input.additionalHolidays.includes(day)) return true;
  if (jurisdiction === "US-FED" && (input.courtClosedDates.includes(day) || (input.direction === "after" && input.stateHolidays.includes(day)))) return true;
  if (jurisdiction === "DE") return deHoliday(day, input);
  if (jurisdiction === "GB-EW") return ukHolidays(year).has(day);
  return usHolidays(year).has(day);
}
/** §188 applies distinct branches; a missing corresponding day ends on month end. */
function periodEnd(trigger: string, count: number, unit: string, beginning: boolean): string {
  if (unit === "days" || unit === "weeks") return addDays(trigger, count * (unit === "weeks" ? 7 : 1) - (beginning ? 1 : 0));
  const date = dayDate(trigger), targetMonth = date.getUTCMonth() + count * (unit === "years" ? 12 : 1);
  const target = new Date(Date.UTC(date.getUTCFullYear(), targetMonth, 1)), last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  if (date.getUTCDate() > last.getUTCDate()) return dayOf(last);
  target.setUTCDate(date.getUTCDate()); return beginning ? addDays(dayOf(target), -1) : dayOf(target);
}
export function calculateDeadline(raw: unknown): DeadlineResult {
  const input = DeadlineInputSchema.parse(raw), skill = DEADLINE_SKILLS.find(s => s.rules.includes(input.rule));
  if (!skill) refuse("unsupported_rule", "No installed calculation rule supports this deadline.");
  yearChecked(input.triggerDate);
  if (input.specialRuleOrOrder) refuse("unsupported_scenario", "A special rule or court order needs a separately supported calculation profile.");
  if (input.additionalHolidays.length || input.stateHolidays.length || input.courtClosedDates.length) required(input.holidaySource, "the official holiday/court-closure source");
  const zone = skill.timeZone ?? required(input.timeZone, "the court's IANA time zone");
  if (skill.timeZone && input.timeZone && input.timeZone !== skill.timeZone) refuse("unsupported_scenario", "This skill requires its jurisdiction time zone.");
  if (!zoneValid(zone)) refuse("missing_inputs", "Provide a valid court time zone.");
  const trace: string[] = [], jurisdiction = skill.jurisdiction;
  let end: string, direction = input.direction === "before" ? -1 : 1;
  if (jurisdiction === "DE") {
    if (direction < 0) refuse("unsupported_scenario", "These German profiles support periods running after the trigger only.");
    required(input.region, "the relevant receiving court/location's Bundesland");
    if (input.courtClosedDates.length) refuse("unsupported_scenario", "Court closures do not automatically extend a German procedural deadline; this requires a separately reviewed rule.");
    let count = input.duration ?? 1, unit = input.unit ?? "months", trigger = input.triggerDate;
    if (!["de-zpo-517", "de-zpo-520"].includes(input.rule)) { count = required(input.duration, "the established period duration"); unit = required(input.unit, "the period unit"); }
    if (input.rule === "de-zpo-517" || input.rule === "de-zpo-520") {
      if (!input.judgmentComplete || input.supplementaryJudgment) refuse("unsupported_scenario", "This profile requires a complete judgment without a supplementary judgment.");
      const pronounced = required(input.pronouncementDate, "the judgment's pronouncement date");
      const latest = periodEnd(pronounced, 5, "months", false);
      if (input.triggerDate < pronounced || input.triggerDate >= latest) refuse("unsupported_scenario", "Service outside the ordinary five-month window requires a separately reviewed latest-commencement profile.");
      trigger = input.triggerDate;
      count = input.rule === "de-zpo-517" ? 1 : 2; unit = "months";
      trace.push(`Complete judgment served ${input.triggerDate}; latest commencement ${latest}; governing trigger ${trigger}.`);
    }
    end = periodEnd(trigger, count, unit, input.rule === "de-bgb-beginning");
    trace.push(`${input.rule === "de-bgb-beginning" ? `Start on ${trigger}, including the beginning day (§187(2))` : `Start on ${addDays(trigger, 1)}, excluding the event day (§187(1))`}.`);
    trace.push(`${count} ${unit} from ${trigger}; nominal end ${end} (§188).`);
    if (input.extensionGrantedDate) {
      if (input.rule !== "de-zpo-520" || !input.extensionSource) refuse("unsupported_scenario", "Only a documented granted §520 extension with an explicit end date is supported.");
      if (input.extensionGrantedDate < end) refuse("unsupported_scenario", "The stated extension date precedes the ordinary period end.");
      end = input.extensionGrantedDate; trace.push(`Use the explicit date granted by the court: ${end}; source: ${input.extensionSource}.`);
    }
    const adjust = input.rule.startsWith("de-zpo-") || required(input.appliesFinalDayAdjustment, "whether §193 applies to this BGB period");
    if (adjust) {
      while (nonworking(end, input, jurisdiction)) { trace.push(`${end} is not a working day; advance one day.`); end = addDays(end, 1); }
      trace.push(`Weekend and statutory-holiday check passed for ${end} (${input.region}${input.municipality ? `, ${input.municipality}` : ""}).`);
    } else trace.push("No final-day adjustment applies, as specified in the inputs.");
  } else {
    if (input.unit && input.unit !== "days") refuse("unsupported_scenario", "This installed profile supports days only.");
    const count = required(input.duration, "the established number of days");
    if (jurisdiction === "US-FED") {
      required(input.court, "the district court");
      if (input.courtClosedDates.length && input.filing !== "court-office") refuse("unsupported_scenario", "A court-office closure does not establish electronic filing-system inaccessibility or extend service. This scenario needs a separately reviewed profile.");
      const triggerType = required(input.triggerType, "whether the period runs after service or another event");
      if (triggerType === "service") required(input.serviceMethod, "the confirmed service method");
      if (triggerType === "event" && input.serviceMethod) refuse("unsupported_scenario", "Service additions cannot be applied to a period triggered by another event.");
      if (!input.courtCalendarConfirmed || !input.holidaySource) refuse("missing_inputs", "Confirm the court/state holiday and closure calendar and supply its source; federal holidays alone are insufficient.");
    }
    end = input.triggerDate;
    for (let remaining = count; remaining > 0;) {
      end = addDays(end, direction);
      if (jurisdiction === "GB-EW" && count <= 5 && nonworking(end, input, jurisdiction)) continue;
      remaining--;
    }
    if (jurisdiction === "GB-EW") {
      if (direction < 0) end = addDays(end, -1);
      else if (required(input.endIsEvent, "whether the end is defined by an event (CPR 2.8(3))")) end = addDays(end, 1);
    }
    trace.push(`Exclude the trigger day; count ${count} ${jurisdiction === "GB-EW" && count <= 5 ? "working clear" : "calendar"} days ${input.direction}; nominal end ${end}.`);
    if (jurisdiction === "US-FED" || input.filing === "court-office") {
      const rollDirection = jurisdiction === "GB-EW" ? 1 : direction;
      while (nonworking(end, input, jurisdiction) || (jurisdiction === "GB-EW" && input.courtClosedDates.includes(end))) { trace.push(`${end} is nonworking; continue to an open day.`); end = addDays(end, rollDirection); }
    }
    if (jurisdiction === "GB-EW" && input.filing === "service" && nonworking(end, input, jurisdiction)) refuse("unsupported_scenario", "Service on a nonworking day needs a supported deemed-service profile; enter a confirmed date manually.");
    if (jurisdiction === "US-FED" && input.serviceMethod && ["mail", "clerk", "consented-other"].includes(input.serviceMethod)) {
      if (direction < 0) refuse("unsupported_scenario", "Rule 6(d) service additions are supported only for periods running after service.");
      end = addDays(end, 3); trace.push("Add three days after ordinary expiration for the specified Rule 6(d) service method.");
      while (nonworking(end, input, jurisdiction)) { trace.push(`${end} after the service addition is nonworking; advance one day.`); end = addDays(end, 1); }
    }
    if (!input.filing) refuse("missing_inputs", "Specify electronic filing, court-office filing, or service.");
    if (input.filing !== "electronic") required(input.cutoffTime, "the established filing/service cutoff time");
    if (jurisdiction === "GB-EW" && input.filing === "electronic") refuse("unsupported_scenario", "Electronic CPR filings require a specific PD5C/court-system profile; this clear-day skill does not guess that cutoff.");
  }
  yearChecked(end);
  const cutoff = input.cutoffTime ? zonedInstant(`${end}T${input.cutoffTime}:00`, zone) : zonedInstant(addDays(end, 1), zone);
  trace.push(input.cutoffTime ? `Cutoff ${input.cutoffTime} on ${end} (${zone}).` : `End of day ${end} (${zone}); exclusive boundary at midnight on ${addDays(end, 1)}.`);
  return { skill: skill.name, version: DEADLINE_RULE_VERSION, rule: input.rule, input, deadlineDay: end, cutoff, timeZone: zone, trace, sources: skill.sources };
}
