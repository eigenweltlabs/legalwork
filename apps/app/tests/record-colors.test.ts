import { expect, test } from "bun:test";
import { stringToThemeColor } from "twenty-ui/utilities";
import { recordColor } from "../src/react-app/domains/back-office/record-colors";
import { calendarDisplayColor } from "../src/react-app/domains/calendar/calendar-colors";
import { selectColor } from "../src/react-app/domains/back-office/select-colors";
import { clampCalendarZoom } from "../src/react-app/domains/calendar/calendar-scale";

test("record identities never receive neutral colors and existing chromatic assignments stay stable", () => {
  const seeds = Array.from({ length: 250 }, (_, i) => "record-" + i);
  expect(seeds.some(seed => stringToThemeColor(seed) === "gray")).toBe(true);
  for (const seed of seeds) {
    expect(["gray", "white", "black"]).not.toContain(recordColor(seed));
    if (stringToThemeColor(seed) !== "gray") expect(recordColor(seed)).toBe(stringToThemeColor(seed));
  }
  for (const status of ["Draft", "Closed", "Cancelled"]) expect(selectColor(status)).not.toBe("gray");
});

test("achromatic provider colors use the calendar identity's chromatic palette", () => {
  for (const color of ["#000000", "#ffffff", "#808080", "#f7f7f7"])
    expect(calendarDisplayColor("calendar", color)).toEqual(calendarDisplayColor("calendar"));
  expect(calendarDisplayColor("calendar", "#1463ce").style).toEqual({ "--calendar-color": "#1463ce" });
});

test("calendar zoom has bounded finite scales", () => {
  expect(clampCalendarZoom(0)).toBe(0.5);
  expect(clampCalendarZoom(100)).toBe(8);
  expect(clampCalendarZoom(NaN)).toBe(1);
  expect(clampCalendarZoom(2.5)).toBe(2.5);
});
