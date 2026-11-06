import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WikiPage } from "@legalwork/types/wiki";
import { researchIndexGroups, researchJurisdictionLabel } from "@legalwork/types/legal-research-wiki";
import { WikiResearchIndex, ResearchClassification } from "../src/react-app/domains/wiki/wiki-research-index";
import { WikiSuggestionDestinationSchema } from "@legalwork/types/wiki-suggestions";

const page = (path: string, properties: WikiPage["properties"] = {}, type = "legal-research"): WikiPage => ({ path, title: path.replace(/\.md$/, ""), type, properties, links: [], excerpt: "", revision: path, updatedAt: 1 });
const pages = [page("Employee privacy.md", { jurisdictions: ["DE", "EU"], primary_area: "privacy-technology", areas: ["employment", "privacy-technology"] }), page("Comparison.md", { jurisdictions: ["US-CA", "DE"], primary_area: "employment", knowledge_type: "comparison" }), page("Earlier finding.md"), page("Wiki.md", { research_index: "areas" }, "index"), page("AGENTS.md", {}, "page")];

test("research browsing links one saved page from every relevant area and jurisdiction without duplicating it", () => {
  const areas = researchIndexGroups(pages, "areas");
  expect(areas.get("privacy-technology")).toHaveLength(1);
  expect(areas.get("employment")).toHaveLength(2);
  expect(areas.get("unclassified")?.map(item => item.path)).toEqual(["Earlier finding.md"]);
  const jurisdictions = researchIndexGroups(pages, "jurisdictions");
  expect(jurisdictions.get("DE")).toHaveLength(2);
  expect(jurisdictions.get("EU")?.[0]).toBe(areas.get("privacy-technology")?.[0]);
  expect(researchIndexGroups(pages, "areas", "US").get("employment")?.map(item => item.path)).toEqual(["Comparison.md"]);
  expect(researchIndexGroups(pages, "areas", "comparative").get("employment")?.map(item => item.path)).toEqual(["Comparison.md"]);
  expect(researchIndexGroups(pages, "areas", "GB").size).toBe(0);
  expect(researchJurisdictionLabel("US-DE", "en")).toBe("Delaware (US)");
  expect(researchJurisdictionLabel("GB-EAW", "en")).toBe("England and Wales");
  expect(researchJurisdictionLabel("INT-ECHR", "de")).toBe("Europäische Menschenrechtskonvention");
});

test("the live index renders saved knowledge and keeps a useful empty state", () => {
  const content = "---\ntype: index\nresearch_index: areas\n---\n# Areas";
  const html = renderToStaticMarkup(<WikiResearchIndex content={content} pages={pages} onOpen={() => {}} />);
  expect(html).toContain("Employee privacy");
  expect(html).toContain("Not classified");
  expect(html).not.toContain("AGENTS.md");
  expect(renderToStaticMarkup(<WikiResearchIndex content={content} pages={[]} onOpen={() => {}} />)).toContain("No saved legal findings");
  expect(renderToStaticMarkup(<WikiResearchIndex content="# Ordinary page" pages={pages} onOpen={() => {}} />)).toBe("");
});

test("draft review displays legal classification and distinguishes law date from research date", () => {
  const html = renderToStaticMarkup(<ResearchClassification content={"---\ntype: legal-research\njurisdictions: [DE, EU]\nprimary_area: privacy-technology\nareas: [employment]\nlaw_as_of: 2025-01-01\nresearched_on: 2026-10-28\n---\n# Finding"} />);
  for (const value of ["Germany", "European Union", "Privacy, technology and media", "Employment and social security", "2025-01-01", "2026-10-28"]) expect(html).toContain(value);
  const destination = WikiSuggestionDestinationSchema.parse({ wikiId: "wiki", path: "Jurisdictions/DE/Contracts/Finding.md", baseRevision: null, createFolders: true });
  expect(destination.createFolders).toBe(true);
  expect(WikiSuggestionDestinationSchema.parse({ wikiId: "wiki", path: "Finding.md", baseRevision: null }).createFolders).toBeUndefined();
});
