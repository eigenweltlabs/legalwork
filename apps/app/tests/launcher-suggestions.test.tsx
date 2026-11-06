import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compareLauncherResults, LauncherSortSchema } from "@legalwork/types/launcher";
import { matchesAssistantSuggestion, matchesSortSuggestion, prioritizeLauncherSuggestions } from "../src/react-app/launcher/launcher-suggestions";
import { LauncherRowMenu } from "../src/react-app/launcher/launcher-row-menu";
import { t } from "../src/i18n";

test("Assistant prefixes from as always win over project filters, aliases and frequently used matches", () => {
  for (const query of ["as", "Ass", "ASSIST", "assistant", " assistant "]) expect(matchesAssistantSuggestion(query, "Ada")).toBe(true);
  for (const query of ["", "a", "assistance agreement", "assistant notes.pdf"]) expect(matchesAssistantSuggestion(query, "Ada")).toBe(false);
  expect(matchesAssistantSuggestion("ad", "Ada")).toBe(true);
  const rows = [{ id: "filter:project:assist", uses: 100 }, { id: "home:recent:assistant.docx", uses: 1000 }, { id: "category:files", uses: 900 }, { id: "search:assistant", uses: 0 }];
  expect(prioritizeLauncherSuggestions(rows, "files")[0].id).toBe("search:assistant");
});

test("sort actions autocomplete in English and German without capturing unrelated search words", () => {
  for (const query of ["so", "sort", "sorted", "sort by", "sorting", "sortieren", "Sortierung", "reihenfolge"]) expect(matchesSortSuggestion(query)).toBe(true);
  for (const query of ["s", "sort contract", "sorted.pdf", "sortiment"]) expect(matchesSortSuggestion(query)).toBe(false);
});

test("sort menu exposes all orders and marks the current selection for keyboard focus", () => {
  const html = renderToStaticMarkup(<LauncherRowMenu title={t("launcher.sort.title")} onClose={() => {}} actions={LauncherSortSchema.options.map(sort => ({ id: sort, title: t(`launcher.sort.${sort}`), checked: sort === "name-asc", run: () => {} }))} />);
  expect(html.match(/role="menuitemradio"/g)).toHaveLength(5);
  expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  expect(html).toContain("Name A–Z");
});

test("explicit sorts override relevance with natural alphabetical order and actual update times", () => {
  const results = [
    { id: "c", title: "Contract 10", updatedAt: 10, score: 1000 },
    { id: "b", title: "contract 2", updatedAt: 30, score: 1 },
    { id: "a", title: "Agreement", updatedAt: 20, score: 500 },
  ];
  const ordered = (sort: Parameters<typeof compareLauncherResults>[2]) => [...results].sort((a, b) => compareLauncherResults(a, b, sort)).map(item => item.id);
  expect(ordered("name-asc")).toEqual(["a", "b", "c"]);
  expect(ordered("name-desc")).toEqual(["c", "b", "a"]);
  expect(ordered("recent")).toEqual(["b", "a", "c"]);
  expect(ordered("oldest")).toEqual(["c", "a", "b"]);
  expect(ordered("relevance")).toEqual(["c", "a", "b"]);
});
