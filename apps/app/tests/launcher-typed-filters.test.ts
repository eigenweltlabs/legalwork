import { expect, test } from "bun:test";
import { dateFilterLabel, fileSourceSuggestions, matchingFilterProjects, matchesLauncherFileFilter, namedFileTypeFilter, typedFilterSuggestions } from "../src/react-app/launcher/launcher-typed-filters";
import { LANGUAGES, t } from "../src/i18n";

test("project filters require at least two characters at word boundaries", () => {
  const projects = [{ id: "aster", name: "Aster Retail - Software Agreement" }];
  for (const query of ["", "f", "a", "ster", "ware", "tail"]) expect(matchingFilterProjects(query, projects)).toEqual([]);
  for (const query of ["as", "RET", "soft", "aster agr"]) expect(matchingFilterProjects(query, projects).map(item => item.id)).toEqual(["aster"]);
  expect(typedFilterSuggestions("f", projects).filter(item => item.project)).toEqual([]);
});

test("match quality outranks current project and recency", () => {
  const projects = [{ id: "current", name: "Retail - Aster" }, { id: "prefix", name: "Aster Retail" }, { id: "exact", name: "Aster" }];
  expect(matchingFilterProjects("aster", projects, { currentProjectId: "current", recentProjectIds: ["current", "prefix"] }).map(item => item.id)).toEqual(["exact", "prefix", "current"]);
});

test("equally good matches prefer the current project, then recent use, and show at most three", () => {
  const projects = ["Alpha", "Beta", "Gamma", "Delta"].map(id => ({ id, name: `Retail ${id}` }));
  expect(matchingFilterProjects("ret", projects, { currentProjectId: "Gamma", recentProjectIds: ["Beta", "Alpha"] }).map(item => item.id)).toEqual(["Gamma", "Beta", "Alpha"]);
  expect(matchingFilterProjects("Beta", projects, { currentProjectId: "Gamma" }).map(item => item.id)).toEqual(["Beta"]);
});

test("display names and accents match, while Wikis and the Assistant remain separate", () => {
  const projects = [{ id: "project", name: "internal", displayName: "Müller – Verträge" }, { id: "wiki", name: "Müller", preset: "wiki" }, { id: "assistant", name: "Müller", preset: "main-assistant" }];
  expect(matchingFilterProjects("muller ver", projects)).toEqual([{ id: "project", name: "Müller – Verträge" }]);
  expect(matchingFilterProjects("internal", projects)).toEqual([]);
});

test("file type labels work in every shipped language and images exclude folders and documents", () => {
  for (const lng of LANGUAGES) {
    for (const name of ["images", "documents", "presentations", "spreadsheets", "emails", "pdf"]) {
      const label = t(`launcher.typed.${name}`, lng);
      expect(namedFileTypeFilter(label)?.name).toBe(name);
      expect(typedFilterSuggestions(label, []).some(item => item.id === `filter:type:${name}`)).toBe(true);
    }
  }
  const imageTypes = namedFileTypeFilter("Bilder")?.extensions ?? [];
  const filter = { types: imageTypes, modifiedAfter: null };
  const files = ["jpg", "WEBP", "svg", "pdf", "docx", "folder"].map(fileType => ({ fileType, title: `Images.${fileType}`, updatedAt: 1 }));
  expect(files.filter(file => matchesLauncherFileFilter(file, filter)).map(file => file.fileType)).toEqual(["jpg", "WEBP", "svg"]);
  expect(namedFileTypeFilter("image rights agreement")).toBeNull();
});

test("date shortcuts work without a number, including localized labels and partial words", () => {
  const now = new Date(2026, 10, 5, 12);
  for (const [unit, queries] of [
    ["weeks", ["last week", "last w", "past week", "letzte Woche", "letzte wo"]],
    ["months", ["last month", "last mo", "past month", "letzter Monat", "letzten Monat"]],
  ] satisfies [string, string[]][]) {
    const explicit = typedFilterSuggestions(`last 1 ${unit}`, [], now);
    for (const query of queries) expect(typedFilterSuggestions(query, [], now)).toEqual(explicit);
  }
  for (const lng of LANGUAGES) {
    for (const unit of ["days", "weeks", "months", "years"]) {
      const label = t(`launcher.typed.last_${unit}`, lng);
      expect(typedFilterSuggestions(label, [], now).map(item => item.id)).toEqual([`filter:date:1:${unit}`]);
    }
  }
});

test("typing last offers week and month ranges with matching chip labels", () => {
  const now = new Date(2026, 10, 5, 12);
  const week = new Date(now); week.setDate(week.getDate() - 7);
  const month = new Date(now); month.setMonth(month.getMonth() - 1);
  const suggestions = typedFilterSuggestions("last", [], now);
  expect(suggestions.map(item => item.title)).toEqual([t("launcher.typed.last_weeks"), t("launcher.typed.last_months"), t("launcher.typed.last_years")]);
  expect(suggestions[0].files?.modifiedAfter).toBe(week.getTime());
  expect(suggestions[1].files?.modifiedAfter).toBe(month.getTime());
  for (const item of suggestions) expect(dateFilterLabel(item.files!.modifiedAfter!, now.getTime())).toBe(item.title);
});

test("explicit date counts still work and invalid date phrases do not become filters", () => {
  const now = new Date(2026, 10, 5, 12);
  const since = new Date(now); since.setDate(since.getDate() - 10);
  expect(typedFilterSuggestions("last 10 days", [], now)[0].files?.modifiedAfter).toBe(since.getTime());
  for (const query of ["last 0 weeks", "last -1 month", "last 1.5 weeks", "last 10001 days", "last invoice", "last week contract"]) {
    expect(typedFilterSuggestions(query, [], now)).toEqual([]);
  }
});

test("file source qualifiers autocomplete English and German names without consuming filenames", () => {
  for (const [kind, queries] of [
    ["project", ["p", "proj", "projects", "projects only", "Projekt", "nur Projekte"]],
    ["wiki", ["w", "wiki", "wikis only", "nur Wikis"]],
    ["folder", ["fol", "folders", "added folders only", "Suchordner", "nur zusätzliche Ordner"]],
  ] satisfies [string, string[]][]) {
    for (const query of queries) expect(fileSourceSuggestions(query).map(item => item.files?.sourceKind)).toEqual([kind]);
    for (const lng of LANGUAGES) expect(fileSourceSuggestions(t(`launcher.typed.source_${kind}`, lng))[0]?.files?.sourceKind).toBe(kind);
  }
  for (const query of ["", "Project agreement.pdf", "Wiki.md", "work"]) expect(fileSourceSuggestions(query)).toEqual([]);
});

test("source filtering combines with file type and date and also excludes folders from other sources", () => {
  const filter = { types: ["pdf"], modifiedAfter: 10, sourceKind: "wiki" } satisfies Parameters<typeof matchesLauncherFileFilter>[1];
  const file = { title: "Contract.pdf", fileType: "pdf", updatedAt: 20, sourceKind: "wiki" } satisfies Parameters<typeof matchesLauncherFileFilter>[0];
  expect(matchesLauncherFileFilter(file, filter)).toBe(true);
  expect(matchesLauncherFileFilter({ ...file, sourceKind: "project" }, filter)).toBe(false);
  expect(matchesLauncherFileFilter({ ...file, updatedAt: 5 }, filter)).toBe(false);
  expect(matchesLauncherFileFilter({ ...file, fileType: "md" }, filter)).toBe(false);
  expect(matchesLauncherFileFilter({ ...file, fileType: "folder", sourceKind: "project" }, { ...filter, types: null })).toBe(false);
  expect(matchesLauncherFileFilter({ ...file, fileType: "folder" }, { ...filter, types: null })).toBe(true);
});
