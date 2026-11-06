import { expect, test } from "bun:test";
import { DEFAULT_LAUNCHER_ALIASES } from "@legalwork/types/launcher";
import { LANGUAGES, t } from "../src/i18n";
import { activateCategoryAlias, categorySuggestions, isBrowseActionQuery, matchesOpenBrowser, namedCategoryQuery, launcherAliasCollisions, looksLikeQuestion, normalizeLauncherAliases, parseLauncherEntry } from "../src/react-app/launcher/launcher-query";

test("an exact alias plus its delimiter becomes a category; bare letters and prose stay text", () => {
  expect(activateCategoryAlias("f Mietvertrag", DEFAULT_LAUNCHER_ALIASES)).toEqual({ category: "files", rest: "Mietvertrag" });
  expect(activateCategoryAlias("p ", DEFAULT_LAUNCHER_ALIASES)).toEqual({ category: "projects", rest: "" });
  expect(activateCategoryAlias("f", DEFAULT_LAUNCHER_ALIASES)).toBeNull();
  expect(activateCategoryAlias("f", DEFAULT_LAUNCHER_ALIASES, "tab")).toEqual({ category: "files", rest: "" });
  expect(activateCategoryAlias("fr Mietvertrag", DEFAULT_LAUNCHER_ALIASES)).toBeNull();
  expect(activateCategoryAlias("Fristen für Müller", DEFAULT_LAUNCHER_ALIASES)).toBeNull();
  expect(activateCategoryAlias("Der Mieter f zahlt", DEFAULT_LAUNCHER_ALIASES)).toBeNull();
  expect(activateCategoryAlias("f\nMietvertrag", DEFAULT_LAUNCHER_ALIASES)).toBeNull();
  const custom = normalizeLauncherAliases({ files: "dok", projects: "P ", tasks: "toolong", chats: "" });
  expect(custom).toEqual({ ...DEFAULT_LAUNCHER_ALIASES, files: "dok", projects: "p" });
  expect(activateCategoryAlias("dok Vertrag", custom)).toEqual({ category: "files", rest: "Vertrag" });
  expect(launcherAliasCollisions({ ...DEFAULT_LAUNCHER_ALIASES, tasks: "f" })).toEqual([{ alias: "f", kinds: ["files", "tasks"] }]);
});

test("slash commands and explicit asks are separate modes; question-shaped text is still a search", () => {
  expect(parseLauncherEntry("/compare a b")).toEqual({ mode: "command", text: "compare a b" });
  expect(parseLauncherEntry("? Was ist im Fall Müller offen?")).toEqual({ mode: "ask", text: "Was ist im Fall Müller offen?" });
  expect(parseLauncherEntry("?")).toEqual({ mode: "ask", text: "" });
  expect(parseLauncherEntry("Was ist offen?")).toEqual({ mode: "search", text: "Was ist offen?" });
  expect(looksLikeQuestion("Was ist offen?")).toBe(true);
  expect(looksLikeQuestion("Mietvertrag Müller")).toBe(false);
});

test("category names browse directly while partial names and configurable shortcuts complete first", () => {
  expect(namedCategoryQuery("tasks")).toEqual({ category: "tasks", rest: "" });
  expect(namedCategoryQuery("Aufgaben Müller Frist")).toEqual({ category: "tasks", rest: "Müller Frist" });
  expect(namedCategoryQuery("tasksXYZ")).toBeNull();
  expect(namedCategoryQuery("tas")).toBeNull();
  expect(categorySuggestions("", DEFAULT_LAUNCHER_ALIASES)).toHaveLength(5);
  expect(categorySuggestions("tas", DEFAULT_LAUNCHER_ALIASES)).toEqual(["tasks"]);
  expect(categorySuggestions("auf", DEFAULT_LAUNCHER_ALIASES)).toEqual(["tasks", "recordings"]);
  expect(categorySuggestions("tasks", DEFAULT_LAUNCHER_ALIASES)).toEqual(["tasks"]);
  expect(categorySuggestions("tasks Müller", DEFAULT_LAUNCHER_ALIASES)).toEqual([]);
  expect(categorySuggestions("Mi", DEFAULT_LAUNCHER_ALIASES)).toEqual([]);
  expect(categorySuggestions("dok", normalizeLauncherAliases({ files: "dok" }))).toEqual(["files"]);
  expect(activateCategoryAlias("Dateien ", DEFAULT_LAUNCHER_ALIASES)).toEqual({ category: "files", rest: "" });
  expect(activateCategoryAlias("Tasks", DEFAULT_LAUNCHER_ALIASES, "tab")).toEqual({ category: "tasks", rest: "" });
});

test("browse action names complete from their visible prefix without confusing them with the browser", () => {
  for (const query of ["b", "br", "brow", "browse", "Browse "]) {
    expect(categorySuggestions(query, DEFAULT_LAUNCHER_ALIASES)).toEqual(["files", "projects", "chats", "tasks", "recordings"]);
    expect(isBrowseActionQuery(query)).toBe(true);
    expect(matchesOpenBrowser(query)).toBe(true);
  }
  expect(categorySuggestions("browse f", DEFAULT_LAUNCHER_ALIASES)).toEqual(["files"]);
  expect(categorySuggestions("browse ta", DEFAULT_LAUNCHER_ALIASES)).toEqual(["tasks"]);
  expect(namedCategoryQuery("Browse Files Agreement")).toEqual({ category: "files", rest: "Agreement" });
  expect(matchesOpenBrowser("browse files")).toBe(false);
  expect(matchesOpenBrowser("browser")).toBe(true);
  expect(matchesOpenBrowser("open bro")).toBe(true);
  expect(matchesOpenBrowser("")).toBe(false);
  expect(categorySuggestions("browser", DEFAULT_LAUNCHER_ALIASES)).toEqual([]);
});

test("every shipped language's visible Browse and Browser labels are searchable", () => {
  for (const lng of LANGUAGES) {
    for (const category of ["files", "projects", "tasks", "chats", "recordings"]) {
      const label = t("launcher.suggest.browse", { lng, category: t(`launcher.kind.${category}`, lng) });
      expect(categorySuggestions(label, DEFAULT_LAUNCHER_ALIASES)).toEqual([category]);
      expect(namedCategoryQuery(label)).toEqual({ category, rest: "" });
    }
    expect(matchesOpenBrowser(t("launcher.browser.open", lng))).toBe(true);
  }
  expect(categorySuggestions("anzeigen", DEFAULT_LAUNCHER_ALIASES)).toHaveLength(5);
  expect(categorySuggestions("Dateien anz", DEFAULT_LAUNCHER_ALIASES)).toEqual(["files"]);
  expect(matchesOpenBrowser("browser offnen")).toBe(true);
});
