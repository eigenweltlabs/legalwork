import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { matchesStopwatchSuggestion, prioritizeLauncherSuggestions } from "../src/react-app/launcher/launcher-suggestions";

test("stopwatch intent is discoverable in English and German without matching document names", () => {
  for (const word of ["ti", "timer", "stopwatch", "time", "timekeeping", "time tracking", "stopp", "Stoppuhr", "zeit", "Zeiterfassung"]) expect(matchesStopwatchSuggestion(word)).toBe(true);
  for (const word of ["", "t", "time contract.pdf", "Stopwatch notes", "timekeeper.docx"]) expect(matchesStopwatchSuggestion(word)).toBe(false);
  expect(prioritizeLauncherSuggestions([{ id: "filter:project:time" }, { id: "home:recent:timer" }, { id: "search:stopwatch" }])[0].id).toBe("search:stopwatch");
});

test("mini-bar stopwatch shares native state and handles keyboard, lost replies and account changes", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/launcher-stopwatch.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Launcher stopwatch regressions passed");
}, 30_000);
