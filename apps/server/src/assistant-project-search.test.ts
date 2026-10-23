import { expect, test } from "bun:test";
import { projectMatch } from "./assistant-project-search.js";

const aster = { id: "aster-id", name: "Project Aster: Due Diligence AsterCloud GmbH", path: "/Projects/SaaS DD Some Company" };
test("project lookup finds the screenshot typo and swapped letters without guessing short terms or matter numbers", () => {
  expect(projectMatch(aster, "alster")).toMatchObject({ match: "approximate" });
  expect(projectMatch(aster, "project atser")).toMatchObject({ match: "approximate" });
  expect(projectMatch(aster, "ASTER")).toMatchObject({ match: "literal" });
  expect(projectMatch(aster, "aster-id")).toMatchObject({ match: "exact" });
  expect(projectMatch(aster, "asx")).toBeNull();
  expect(projectMatch(aster, "unrelated litigation")).toBeNull();
  expect(projectMatch({ ...aster, name: "Matter 1001" }, "1002")).toBeNull();
  expect(projectMatch({ ...aster, name: "Müller Straße" }, "muller strasse")).toMatchObject({ match: "exact" });
});

test("exact identities rank ahead of typo candidates, including ambiguous names in a 500-project collection", () => {
  const projects = [...Array.from({ length: 500 }, (_, i) => ({ id: `p-${i}`, name: `Matter ${i}`, path: `/Projects/${i}` })), aster,
    { ...aster, id: "alster", name: "Alster" }, { ...aster, id: "alter", name: "Alter" }];
  const ranked = projects.flatMap(project => { const match = projectMatch(project, "alster"); return match ? [{ id: project.id, ...match }] : []; }).sort((a, b) => a.score - b.score);
  expect(ranked.map(item => item.id)).toEqual(["alster", "aster-id", "alter"]);
  expect(ranked[0].match).toBe("exact");
  expect(ranked.slice(1).every(item => item.match === "approximate")).toBe(true);
});

test("a matter can be found by saved client and reference metadata without fuzzy guessing", () => {
  const project = { id: "matter", name: "Matter 1001", path: "/Projects/Matter 1001" };
  expect(projectMatch(project, "Nordstern", "Nordstern GmbH AB-987")).toEqual({ score: 2.5, match: "metadata" });
  expect(projectMatch(project, "AB-987", "Nordstern GmbH AB-987")?.match).toBe("metadata");
  expect(projectMatch(project, "AB-988", "Nordstern GmbH AB-987")).toBeNull();
});
