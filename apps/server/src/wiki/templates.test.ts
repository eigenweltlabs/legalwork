import { describe, expect, test } from "bun:test";
import { parseWikiPage, resolveWikiLinks } from "./markdown.js";
import { createWikiStarterFiles, WIKI_CONTROL_FILES, type WikiStarterTemplate } from "./templates.js";

describe("portable wiki starters", () => {
  const templates: WikiStarterTemplate[] = ["firm", "blank"];
  test.each(templates)("%s includes editable synthesis guidance for every page type", template => {
    const files = createWikiStarterFiles(template, "Custom knowledge");
    expect(files["Structure.md"]).toContain("every region and page type");
    expect(files["Structure.md"]).toContain("whatever names, folders or templates");
    expect(files["Structure.md"]).toContain("Reconcile entities and topics");
    expect(files["Structure.md"]).toContain("Every source folder having a page is not completion");
    expect(files["Structure.md"]).toContain("clickable evidence is not required to complete onboarding");
    expect(files["Structure.md"]).toContain("Colleagues may not have the same drive connection or permissions");
    for (const path of ["AGENTS.md", "Structure.md", template === "firm" ? "Skills/wiki-setup/SKILL.md" : "Skills/Bootstrap.md"]) {
      expect(files[path]).toContain("Clean, reusable templates may be copied");
      expect(files[path]).toContain("Never copy original client or matter documents");
      expect(files[path]).toContain("supporting legal sources");
      expect(files[path]).toContain("requireAgentApproval");
      expect(files[path]).toContain("waits for Save to wiki or is published in the background");
    }
    const capture = files[template === "firm" ? "Skills/wiki-capture/SKILL.md" : "Skills/Capture.md"];
    expect(capture).toContain("When requireAgentApproval is on");
    expect(capture).toContain("When it is off, wiki_suggest publishes in the background");
    expect(capture).toContain("Never bypass required review with file tools");
    expect(Object.values(files).join("\n")).not.toMatch(/only the user clicks Save to wiki|only a user Save publishes|Never publish it yourself/);
    expect(files["Structure.md"]).toContain("including their properties, code blocks and Sources/ pages");
    expect(files["Structure.md"]).toContain("Do not create a provenance catalog, import log or evidence dump");
    expect(Object.values(files).join("\n")).not.toMatch(/with a tested link|Verify that (readers|a colleague) can open|copy the selected supporting document into Sources|copy only attachments needed|provenance behind readable references/);
    expect(Object.values(files).join("\n")).not.toContain("resumable progress in a Markdown research page");
  });
  test("firm workflows and folder landing pages resolve without invented entity records", () => {
    const files = createWikiStarterFiles("firm", "Our firm");
    const pages = resolveWikiLinks(Object.entries(files).map(([path, content]) => parseWikiPage(path, content, "starter", 1).page));
    expect(pages.flatMap((page) => page.links.filter((link) => !link.resolved).map((link) => `${page.path}: ${link.target}`))).toEqual([]);
    expect(pages.every(page => page.properties.views === undefined)).toBe(true);
    expect(pages.filter((page) => ["client", "matter", "person"].includes(String(page.properties.type)))).toEqual([]);
    for (const folder of ["Clients", "Matters", "Knowledge", "Processes", "Templates", "Firm", "Sources", "Dashboards", "Reports"]) {
      expect(pages.find((page) => page.path === `${folder}/${folder}.md`)?.properties.type).toBe("index");
    }
    expect(Object.keys(files).filter(path => path.endsWith("AGENTS.md")).sort()).toEqual(["AGENTS.md", "Knowledge/AGENTS.md", "Templates/AGENTS.md"]);
    expect(Object.keys(files).filter(path => path.endsWith("/SKILL.md"))).toHaveLength(4);
    expect(files["Skills/wiki-setup/SKILL.md"]).toContain("next folder/cursor");
    expect(files["Skills/wiki-setup/SKILL.md"]).toContain("Continue through the full requested scope");
    expect(files["Skills/wiki-setup/SKILL.md"]).not.toContain("initially up to three matters");
    expect(files["Skills/wiki-setup/SKILL.md"]).toContain("Never create Sources/Import.md");
    expect(files["Skills/wiki-setup/SKILL.md"]).toContain("Reading source documents never requires opening an in-app viewer");
    expect(files["Skills/wiki-setup/SKILL.md"]).toContain("do not crawl connected storage");
    expect(files["Firm/About.md"]).toBeUndefined();
    expect(files["Sources/Import.md"]).toBeUndefined();
    for (const retired of ["Instructions.md", "Templates.md", "Views.md", "Skills/Bootstrap.md"]) expect(files[retired]).toBeUndefined();
    expect(files["Skills/wiki-setup/SKILL.md"]).toContain("requireAgentApproval controls whether publication waits for Save to wiki or happens in the background");
    expect(files["Skills/wiki-use/SKILL.md"]).toContain("server groupBy/metrics");
    expect(files["Skills/wiki-use/SKILL.md"]).toContain("view_create");
    expect(files["Skills/wiki-use/SKILL.md"]).toContain("legalwork-view");
    expect(Object.values(files).join("\n")).not.toContain("\u2014");
    expect(pages.some((page) => page.path === "Templates/Process page.md" && page.properties.template_for === "process")).toBe(true);
  });

  test("blank starter keeps editable control files and procedures without invented firm knowledge", () => {
    const files = createWikiStarterFiles("blank", "Notes\nwith a title");
    expect(WIKI_CONTROL_FILES.every((path) => typeof files[path] === "string")).toBe(true);
    expect(files["Wiki.md"]).toStartWith("# Notes with a title\n");
    expect(Object.keys(files).some((path) => path.startsWith("Processes/") || path.startsWith("Research/"))).toBe(false);
    expect(files["Structure.md"]).toContain("Write your inclusion criteria");
    expect(files["Skills/Bootstrap.md"]).toContain("storage_read_file");
    expect(files["Instructions.md"]).toContain("sync automatically");
    expect(files["Skills/Anonymize.md"]).toContain("frontmatter, source labels, links, filenames, attachment names");
    expect(files["Views.md"]).toContain("view_create");
    expect(files["Views.md"]).toContain(".view.json");
    expect(Object.entries(files).every(([path, content]) => parseWikiPage(path, content, "starter", 1).page.properties.views === undefined)).toBe(true);
  });
});
