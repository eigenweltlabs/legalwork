import { expect, test } from "bun:test";
import { createSkippedSkillsTracker } from "../src/react-app/domains/settings/state/skipped-skills-tracker";

test("reports each skipped skill once until it is fixed or its reason changes", () => {
  const next = createSkippedSkillsTracker();
  const broken = { path: "/skills/broken/SKILL.md", reason: "Invalid YAML" };
  const other = { path: "/skills/other/SKILL.md", reason: "Missing description" };

  expect(next("desktop-global", [broken])).toEqual([broken]);
  expect(next("desktop-global", [broken])).toEqual([]);
  expect(next("desktop-global", [broken, other])).toEqual([other]);
  expect(next("desktop-global", [{ ...broken, reason: "Missing name" }, other])).toEqual([{ ...broken, reason: "Missing name" }]);
  expect(next("desktop-global", [])).toEqual([]);
  expect(next("desktop-global", [broken])).toEqual([broken]);
});

test("keeps skipped-skill reports separate by source", () => {
  const next = createSkippedSkillsTracker();
  const broken = { path: "/skills/broken/SKILL.md", reason: "Invalid YAML" };

  expect(next("workspace-a", [broken])).toEqual([broken]);
  expect(next("workspace-b", [broken])).toEqual([broken]);
  expect(next("workspace-a", [broken])).toEqual([]);
});
