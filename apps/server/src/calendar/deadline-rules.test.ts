import { describe, expect, test } from "bun:test";
import { calculateDeadline, DEADLINE_SKILLS } from "./deadline-rules.js";
import { zonedInstant } from "./dates.js";
import { calculate } from "./calculator-entry.js";
import oracleFixtures from "./fixtures/deadline-oracles.json" with { type: "json" };

const de = { rule: "de-zpo-period", region: "NW", duration: 1, unit: "months", source: "Confirmed service record and applicable period" };
const ew = { endIsEvent: false, rule: "ew-cpr-clear-days", filing: "service", cutoffTime: "16:00", source: "Confirmed event and applicable CPR period" };
const us = { triggerType: "service", serviceMethod: "electronic", rule: "us-frcp-6-days", court: "SDNY", courtCalendarConfirmed: true, holidaySource: "Court holiday calendar checked", timeZone: "America/New_York", filing: "electronic", source: "Confirmed trigger and FRCP period" };
describe("supported legal rules (primary-source regression cases)", () => {
  test.each(oracleFixtures.cases)("recorded LTO and Gebühren-Portal comparison %#", fixture => {
    const actual = calculateDeadline({ ...fixture.input, rule: "de-zpo-period", source: "Synthetic comparison fixture" }).deadlineDay;
    expect(actual).toBe(fixture.ltoDate); expect(actual).toBe(fixture.portalDate);
  });
  test.each([
    ["2026-01-31", "2026-03-02"], ["2024-01-31", "2024-02-29"], ["2025-01-31", "2025-02-28"],
    ["2026-03-31", "2026-04-30"], ["2026-07-31", "2026-08-31"], ["2026-11-30", "2026-12-30"],
  ])("German event months from %s end %s", (triggerDate, expected) => expect(calculateDeadline({ ...de, triggerDate }).deadlineDay).toBe(expected));
  test("LTO observed oracle: 31 Jan 2026, one month, NRW, §193 applies → 2 March", () => {
    // Recorded through LTO's calculator during research; not represented as a live website check.
    expect(calculateDeadline({ ...de, rule: "de-bgb-event", appliesFinalDayAdjustment: true, triggerDate: "2026-01-31" }).deadlineDay).toBe("2026-03-02");
  });
  test.each([
    ["de-bgb-event", "2026-07-01", "2026-08-01"], ["de-bgb-beginning", "2026-07-01", "2026-07-31"],
    ["de-bgb-event", "2024-01-29", "2024-02-29"], ["de-bgb-beginning", "2024-01-29", "2024-02-28"],
    ["de-bgb-event", "2025-01-31", "2025-02-28"], ["de-bgb-beginning", "2025-01-31", "2025-02-28"],
  ])("§188 branch %s from %s", (rule, triggerDate, expected) => expect(calculateDeadline({ ...de, rule, triggerDate, appliesFinalDayAdjustment: false }).deadlineDay).toBe(expected));
  test.each([
    ["BE", "2020-05-07", {}, "2020-05-11"], ["BE", "2025-05-07", {}, "2025-05-09"], ["BE", "2028-06-16", {}, "2028-06-19"],
    ["NW", "2025-06-18", {}, "2025-06-20"], ["SN", "2025-06-18", { localCorpusChristi: false }, "2025-06-19"],
    ["SN", "2025-06-18", { localCorpusChristi: true }, "2025-06-20"], ["TH", "2024-09-19", {}, "2024-09-23"],
    ["BE", "2024-03-07", {}, "2024-03-11"], ["NW", "2024-03-07", {}, "2024-03-08"],
    ["MV", "2021-03-07", {}, "2021-03-08"], ["MV", "2024-03-07", {}, "2024-03-11"],
    ["SN", "2025-11-18", {}, "2025-11-20"], ["BY", "2025-08-07", { municipality: "Augsburg" }, "2025-08-11"],
    ["BY", "2025-08-07", { municipality: "München" }, "2025-08-08"],
    ["BY", "2025-08-14", { municipality: "München", catholicMunicipality: true }, "2025-08-18"],
    ["BY", "2025-08-14", { municipality: "Nürnberg", catholicMunicipality: false }, "2025-08-15"],
  ])("regional holiday %s from %s", (region, triggerDate, facts, expected) => expect(calculateDeadline({ ...de, duration: 1, unit: "days", region, triggerDate, ...facts }).deadlineDay).toBe(expected));
  test.each(["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"])("Easter chain in %s", region => {
    expect(calculateDeadline({ ...de, region, unit: "days", triggerDate: "2026-04-02" }).deadlineDay).toBe("2026-04-07");
  });
  test("ordinary §§517/520 service and explicit granted extension", () => {
    const facts = { ...de, triggerDate: "2026-02-10", pronouncementDate: "2026-01-10", judgmentComplete: true };
    expect(calculateDeadline({ ...facts, rule: "de-zpo-517" }).deadlineDay).toBe("2026-03-10");
    expect(calculateDeadline({ ...facts, rule: "de-zpo-520", extensionGrantedDate: "2026-05-11", extensionSource: "Court order granting extension to 11 May" }).deadlineDay).toBe("2026-05-11");
  });
  test.each([
    ["2023-10-20", 3, "before", "2023-10-16"], ["2025-10-20", 3, "before", "2025-10-14"],
    ["2026-10-02", 14, "after", "2026-10-16"], ["2026-04-01", 3, "after", "2026-04-08"],
    ["2022-06-01", 2, "after", "2022-06-07"], ["2023-05-05", 1, "after", "2023-05-09"],
  ])("CPR clear days from %s", (triggerDate, duration, direction, expected) => expect(calculateDeadline({ ...ew, triggerDate, duration, direction }).deadlineDay).toBe(expected));
  test("CPR event-defined end excludes both notice and hearing days", () => expect(calculateDeadline({ ...ew, triggerDate: "2026-10-01", duration: 28, endIsEvent: true }).deadlineDay).toBe("2026-10-30"));
  test("court closures affect filing, not counting short CPR service periods", () => {
    const facts = { ...ew, triggerDate: "2026-09-01", duration: 1, courtClosedDates: ["2026-09-02"], holidaySource: "Court notice" };
    expect(calculateDeadline(facts).deadlineDay).toBe("2026-09-02");
    expect(calculateDeadline({ ...facts, filing: "court-office" }).deadlineDay).toBe("2026-09-03");
  });
  test.each([
    ["2026-07-02", 1, "after", "electronic", "2026-07-06"], ["2026-07-01", 1, "after", "mail", "2026-07-06"],
    ["2026-07-01", 1, "after", "electronic", "2026-07-02"], ["2026-07-05", 2, "before", "personal", "2026-07-02"],
    ["2026-06-18", 1, "after", "personal", "2026-06-22"], ["2020-06-18", 1, "after", "personal", "2020-06-19"],
  ])("FRCP 6 from %s with %s days", (triggerDate, duration, direction, serviceMethod, expected) => expect(calculateDeadline({ ...us, triggerDate, duration, direction, serviceMethod }).deadlineDay).toBe(expected));
  test("state holidays apply only to forward FRCP periods", () => {
    const facts = { ...us, duration: 1, stateHolidays: ["2026-02-12"] };
    expect(calculateDeadline({ ...facts, triggerDate: "2026-02-11" }).deadlineDay).toBe("2026-02-13");
    expect(calculateDeadline({ ...facts, triggerDate: "2026-02-13", direction: "before" }).deadlineDay).toBe("2026-02-12");
  });
  test("legal midnight retains the court's timezone", () => expect(calculateDeadline({ ...us, triggerDate: "2026-07-01", duration: 1 }).cutoff).toBe("2026-07-03T04:00:00.000Z"));
  test("installed executable entry and source share one implementation", () => {
    const input = { ...de, triggerDate: "2026-01-31" };
    expect(calculate(input)).toEqual(calculateDeadline(input)); expect(DEADLINE_SKILLS).toHaveLength(3);
  });
});
describe("refuse unsupported or incomplete calculations", () => {
  test.each([
    { ...de, rule: "de-ao-122", triggerDate: "2026-01-01" },
    { ...de, triggerDate: "2036-01-01" }, { ...de, triggerDate: "2026-01-01", region: undefined },
    { ...de, triggerDate: "2025-08-07", unit: "days", region: "BY" },
    { ...de, triggerDate: "2025-08-14", unit: "days", region: "BY", municipality: "München" },
    { ...de, rule: "de-bgb-event", triggerDate: "2026-01-01" },
    { ...de, triggerDate: "2026-01-01", specialRuleOrOrder: true },
    { ...de, rule: "de-zpo-517", triggerDate: "2026-07-01", pronouncementDate: "2026-01-01", judgmentComplete: true },
    { ...de, rule: "de-zpo-517", triggerDate: "2026-02-01", pronouncementDate: "2026-01-01", judgmentComplete: true, supplementaryJudgment: true },
    { ...ew, triggerDate: "2026-01-01", duration: 3, filing: "electronic" },
    { ...ew, triggerDate: "2026-01-01", duration: 3, cutoffTime: undefined },
    { ...us, triggerDate: "2026-01-01", duration: 3, courtCalendarConfirmed: false },
    { ...us, triggerDate: "2026-01-01", duration: 3, unit: "weeks" },
    { ...us, triggerDate: "2026-01-01", duration: 3, courtClosedDates: ["2026-01-05"] },
  ])("reject %#", input => expect(() => calculateDeadline(input)).toThrow());
  test("DST gaps and folds require an explicit offset", () => {
    expect(() => zonedInstant("2026-03-29T02:30:00", "Europe/Berlin")).toThrow();
    expect(() => zonedInstant("2026-10-25T02:30:00", "Europe/Berlin")).toThrow();
    expect(zonedInstant("2026-10-25T02:30:00+02:00", "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z");
  });
});
