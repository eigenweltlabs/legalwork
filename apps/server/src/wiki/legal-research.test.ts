import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../types.js";
import { WikiStore } from "./store.js";
import { startServer } from "../server.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./agent-access.js";
import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
import WikiTools from "../opencode-plugins/legalwork-wiki-tools.js";
import { legalResearchCaptureGuidance } from "../legal-research-guidance.js";
import { CORE_OPENCODE_FILES } from "../core-skills.js";
import { legalResearchWikiFiles } from "./legal-research-template.js";
import { researchIndexGroups } from "@legalwork/types/legal-research-wiki";
import { openSqlite } from "../runtime-db.js";

test("research starts with saved knowledge and limits external work to missing or outdated findings", () => {
  const skill = CORE_OPENCODE_FILES.find(file => file.path === ".opencode/skills/legal-research/SKILL.md")!.content;
  expect(skill.indexOf("## Start with saved research")).toBeLessThan(skill.indexOf("## Select sources for remaining research"));
  expect(skill).toContain(legalResearchCaptureGuidance);
  for (const instruction of ["wiki_search", "wiki_read", "before starting external research", "Research externally only for gaps", "cite the wiki page and underlying sources", "instead of creating a duplicate"])
    expect(legalResearchCaptureGuidance).toContain(instruction);
});

test.each(["en", "de"] satisfies Array<"en" | "de">)("%s unchanged v3 research instructions gain wiki-first reuse, preserving custom guidance", async language => {
  const { root, config } = await fixture(), store = new WikiStore(config);
  try {
    const { wiki } = await store.ensureLegalResearch(language);
    const page = await store.read(wiki!.id, "AGENTS.md");
    const previous = page.content.replace(legalResearchCaptureGuidance, legalResearchCaptureGuidance.slice(legalResearchCaptureGuidance.indexOf("## Filing legal research")));
    await store.write(wiki!.id, "AGENTS.md", previous, page.revision);
    const reset = async () => { const db = await openSqlite(join(store.baseDir, "wiki-state.sqlite")); try { db.run("UPDATE wiki_research_structure SET version=3 WHERE wiki=?", [wiki!.id]); } finally { db.close(); } };
    await reset();
    await store.ensureLegalResearch(language);
    const updated = await store.read(wiki!.id, "AGENTS.md");
    expect(updated.content).toContain("Reuse saved legal research first");
    const custom = previous + "\nCustom research instructions.\n";
    await store.write(wiki!.id, "AGENTS.md", custom, updated.revision);
    await reset(); await store.ensureLegalResearch(language);
    expect((await store.read(wiki!.id, "AGENTS.md")).content).toBe(custom);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "research-wiki-")), project = join(root, "project");
  await mkdir(project);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "config", "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "project", name: "Project", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [project], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  return { root, project, config };
}

test.each(["en", "de"] satisfies Array<"en" | "de">)("%s research starter creates a named research wiki through the normal creation API", async language => {
  const { root, config } = await fixture(), store = new WikiStore(config);
  const server = await startServer(config);
  const url = `http://127.0.0.1:${server.port}`;
  const headers = { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" };
  const create = (body: unknown) => fetch(`${url}/wikis`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const original = await store.ensureLegalResearch(language, "US");
    const originalHome = await store.read(original.wiki!.id, "Wiki.md");
    expect((await create({ name: "Research", template: "legal-research", language: "fr" })).status).toBe(400);
    expect((await create({ name: "Research", template: "legal-research", country: "ZZ" })).status).toBe(400);
    const response = await create({ name: "Our research", template: "legal-research", language, country: "DE" });
    expect(response.status).toBe(201);
    const { wiki } = await response.json();
    expect(wiki).toMatchObject({ name: "Our research", purpose: "legal-research", sync: null, writable: true });
    expect(wiki.id).not.toBe(original.wiki!.id);
    const snapshot = await store.snapshot(wiki.id);
    expect(snapshot.pages.map(page => page.path).sort()).toEqual(Object.keys(legalResearchWikiFiles(language, "DE").files).sort());
    expect(snapshot.pages.filter(page => page.type === "legal-research")).toHaveLength(0);
    expect((await store.read(wiki.id, "Wiki.md")).content).toContain("# Our research");
    expect((await store.read(wiki.id, "AGENTS.md")).content).toContain("LEGAL KNOWLEDGE ONLY");
    expect((await store.read(wiki.id, "AGENTS.md")).content).toContain("requireAgentApproval");
    const jurisdiction = language === "de" ? "Rechtsordnungen/Deutschland" : "Jurisdictions/Germany";
    const staged = await fetch(`${url}/workspace/project/wiki-suggestions`, { method: "POST", headers, body: JSON.stringify({ title: "Synthetic finding", content: "---\ntype: legal-research\n---\n# Synthetic finding", destination: { wikiId: wiki.id, path: `${jurisdiction}/Contracts/Finding.md`, baseRevision: null, createFolders: true } }) });
    expect(staged.status).toBe(201);
    expect((await store.snapshot(wiki.id)).folders).not.toContain(`${jurisdiction}/Contracts`);
    expect((await store.ensureLegalResearch(language, "DE")).wiki?.id).toBe(original.wiki!.id);
    expect((await store.read(original.wiki!.id, "Wiki.md")).revision).toBe(originalHome.revision);
  } finally { await store.close(); await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test("manual research starters preserve their locale and country when adopted and do not replace the personal default with a shared wiki", async () => {
  const { root, config } = await fixture(), store = new WikiStore(config);
  try {
    const shared = await store.create({ name: "Team research", template: "legal-research", language: "en", country: "US", sync: { kind: "team", wikiId: "7a389f79-b2ce-41a8-9829-f8904a8ac844", orgId: "firm" } });
    const personal = await store.create({ name: "My research", template: "legal-research", language: "de", country: "DE" });
    const before = await store.snapshot(personal.id);
    const result = await store.ensureLegalResearch("en", "US");
    expect(result).toMatchObject({ created: false, wiki: { id: personal.id } });
    expect(result.wiki?.id).not.toBe(shared.id);
    expect((await store.snapshot(personal.id)).pages).toEqual(before.pages);
    const attached = await store.create({ name: "Existing folder", template: "legal-research", attach: true });
    expect(attached.purpose).toBeUndefined();
    expect((await store.snapshot(attached.id)).pages).toEqual([]);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test.each(["en", "de"] satisfies Array<"en" | "de">)("%s default research wiki is personal, idempotent and preserves edits, renames and removal", async language => {
  const { root, config } = await fixture();
  let store = new WikiStore(config);
  try {
    const name = language === "de" ? "Rechtliche Recherche" : "Legal Research";
    const unrelated = await store.create({ name, template: "blank" });
    const results = await Promise.all(Array.from({ length: 4 }, () => store.ensureLegalResearch(language)));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.wiki?.id)).size).toBe(1);
    const wiki = results[0].wiki!;
    expect(wiki.requireAgentApproval).toBe(false);
    expect(wiki).toMatchObject({ name, purpose: "legal-research", sync: null, allowInProjects: true });
    expect(wiki.id).not.toBe(unrelated.id);
    expect((await store.snapshot(wiki.id)).pages.map(page => page.path).sort()).toEqual(Object.keys(legalResearchWikiFiles(language).files).sort());
    expect(await readFile(join(wiki.root, "Wiki.md"), "utf8")).toContain(`# ${name}`);
    expect((await store.read(wiki.id, "AGENTS.md")).content).toContain("LEGAL KNOWLEDGE ONLY");
    await store.update(wiki.id, { name: "My case law", allowInProjects: false });
    await store.write(wiki.id, "Finding.md", "# User-authored legal finding\n\nPreserve this source-backed analysis.", "");
    const home = await store.read(wiki.id, "Wiki.md");
    await store.write(wiki.id, "Wiki.md", "# My own introduction", home.revision);
    await store.close(); store = new WikiStore(config);
    expect(await store.ensureLegalResearch(language === "de" ? "en" : "de")).toMatchObject({ created: false, wiki: { id: wiki.id, name: "My case law", allowInProjects: false } });
    expect((await store.read(wiki.id, "Wiki.md")).content).toBe("# My own introduction");
    expect((await store.read(wiki.id, "Finding.md")).content).toContain("Preserve this");
    await store.archive(wiki.id);
    expect(await store.ensureLegalResearch(language)).toEqual({ wiki: null, created: false });
    await store.restoreWiki(wiki.id);
    expect((await store.ensureLegalResearch(language)).wiki?.id).toBe(wiki.id);
    await store.forget(wiki.id);
    await store.close(); store = new WikiStore(config);
    expect(await store.ensureLegalResearch(language)).toEqual({ wiki: null, created: false });
    expect((await store.list()).map(item => item.id)).toEqual([unrelated.id]);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("research wiki migration respects read-only mode and recovers the registration/marker boundary", async () => {
  const { root, config } = await fixture(), store = new WikiStore(config);
  try {
    config.readOnly = true;
    await expect(store.ensureLegalResearch("en")).rejects.toMatchObject({ code: "read_only" });
    expect(await store.list()).toEqual([]);
    config.readOnly = false;
    const first = await store.ensureLegalResearch("en");
    const db = await openSqlite(join(store.baseDir, "wiki-state.sqlite"));
    try { db.run("DELETE FROM wiki_defaults"); } finally { db.close(); }
    expect(await store.ensureLegalResearch("de")).toMatchObject({ created: false, wiki: { id: first.wiki!.id, name: "Legal Research" } });
    expect(await store.list()).toHaveLength(1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("default wiki is owner-provisioned and requested legal findings stage until the human saves", async () => {
  const { root, config, project } = await fixture();
  const previous = Object.fromEntries(["LEGALWORK_SERVER_URL", "LEGALWORK_SERVER_TOKEN", "LEGALWORK_WIKI_AGENT_TOKEN"].map(key => [key, process.env[key]]));
  const agentToken = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "research", directory: project, scope: "owner" });
  const server = await startServer(config), store = new WikiStore(config);
  const url = `http://127.0.0.1:${server.port}`;
  const headers = { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" };
  const ensure = (body: unknown, owner = true) => fetch(`${url}/wikis/legal-research/ensure`, { method: "POST", headers: owner ? headers : { Authorization: "Bearer client", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await ensure({ language: "en" }, false)).status).toBe(401);
    expect((await ensure({ language: "fr" })).status).toBe(400);
    expect(await store.list()).toEqual([]);
    const result = await ensure({ language: "de" });
    expect(result.status).toBe(200);
    const { wiki } = await result.json();
    expect(wiki.name).toBe("Rechtliche Recherche");
    expect(wiki.requireAgentApproval).toBe(false);
    await store.update(wiki.id, { requireAgentApproval: true });
    config.readOnly = true;
    expect((await ensure({ language: "en" })).status).toBe(403);
    config.readOnly = false;
    process.env.LEGALWORK_SERVER_URL = url;
    process.env.LEGALWORK_SERVER_TOKEN = config.token;
    process.env.LEGALWORK_WIKI_AGENT_TOKEN = agentToken;
    const plugin = await nativePluginTools(WikiTools, { directory: project, sessionID: "research" });
    try {
      const prompt: { system: Array<{ type: "text"; text: string }> } = { system: [] };
      await plugin.runtime.hook("session", "context", prompt);
      expect(prompt.system.some(part => part.text.includes(legalResearchCaptureGuidance))).toBe(true);
      expect(CORE_OPENCODE_FILES.find(file => file.path === ".opencode/skills/legal-research/SKILL.md")?.content).toContain(legalResearchCaptureGuidance);
      expect(legalResearchCaptureGuidance).toContain("Do not wait for a separate request");
      expect(legalResearchCaptureGuidance).toContain("Download the relevant judgments");
      const listed = JSON.parse(await plugin.tool.wiki_list.execute({}));
      expect(listed.wikis).toContainEqual({ id: wiki.id, name: wiki.name, purpose: "legal-research", requireAgentApproval: true, writable: true, shared: false });
      const guidance = JSON.parse(await plugin.tool.wiki_guidance.execute({ wiki_id: wiki.id }));
      expect(guidance).toMatchObject({ purpose: "legal-research", access_mode: "suggestion" });
      expect(JSON.stringify(guidance.guidance)).toContain("Do not add process pages");
      expect((await store.snapshot(wiki.id)).pages.map(page => page.path).sort()).toEqual(Object.keys(legalResearchWikiFiles("de").files).sort());
      // Automatic preparation still honors the default human publication boundary.
      const staged = JSON.parse(await plugin.tool.wiki_suggest.execute({ title: "Synthetic legal finding", content: "---\ntype: legal-research\njurisdiction: fixture\n---\n# Synthetic legal finding\n\nA test-only legal synthesis with its supporting authority and limits.", destination: { wikiId: wiki.id, path: "Rechtsordnungen/Deutschland/Vertragsrecht/Finding.md", baseRevision: null, createFolders: true } }));
      expect(staged).toMatchObject({ staged: true, published: false });
      await expect(store.read(wiki.id, "Rechtsordnungen/Deutschland/Vertragsrecht/Finding.md")).rejects.toMatchObject({ status: 404 });
      expect((await store.snapshot(wiki.id)).folders).not.toContain("Rechtsordnungen/Deutschland/Vertragsrecht");
      expect(await readFile(join(project, staged.suggestion.filePath), "utf8")).toContain("test-only legal synthesis");
      const agentHeaders = { Authorization: "Bearer client", "Content-Type": "application/json", "x-legalwork-wiki-agent-token": agentToken, "x-legalwork-wiki-agent-session": "research", "x-legalwork-wiki-agent-directory": encodeURIComponent(project) };
      expect((await fetch(`${url}/wikis/legal-research/ensure`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ language: "en" }) })).status).toBe(403);
      const savePath = `${url}/workspace/project/wiki-suggestions/${staged.suggestion.id}/save`;
      const body = JSON.stringify({ revision: staged.suggestion.revision });
      expect((await fetch(savePath, { method: "POST", headers: agentHeaders, body })).status).toBe(403);
      expect((await fetch(savePath, { method: "POST", headers, body })).status).toBe(200);
      expect((await store.read(wiki.id, "Rechtsordnungen/Deutschland/Vertragsrecht/Finding.md")).content).toContain("test-only legal synthesis");
      expect((await store.snapshot(wiki.id)).folders).toContain("Rechtsordnungen/Deutschland/Vertragsrecht");
    } finally { await plugin.close(); }
  } finally {
    await store.close(); await server.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["en", "de"] satisfies Array<"en" | "de">)("%s structured wiki upgrades only untouched v1 controls and seeds the country once", async language => {
  const { root, config } = await fixture();
  let store = new WikiStore(config);
  try {
    const wiki = (await store.ensureLegalResearch(language)).wiki!;
    const legacy = JSON.parse(await readFile(new URL("./fixtures/legal-research-v1.json", import.meta.url), "utf8"));
    for (const path of Object.keys(legalResearchWikiFiles(language).files)) await rm(join(wiki.root, path));
    await writeFile(join(wiki.root, "Wiki.md"), legacy.homes[language]);
    await writeFile(join(wiki.root, "AGENTS.md"), legacy.guidance);
    await store.write(wiki.id, "User finding.md", "---\ntype: legal-research\n---\n# Keep this finding", "");
    const db = await openSqlite(join(store.baseDir, "wiki-state.sqlite"));
    try { db.run("DELETE FROM wiki_research_structure"); } finally { db.close(); }
    await store.close(); store = new WikiStore(config);
    expect((await store.ensureLegalResearch(language === "de" ? "en" : "de", "DE")).updated).toBe(true);
    const snapshot = await store.snapshot(wiki.id);
    expect(snapshot.pages.some(page => page.properties.research_scope === "DE")).toBe(true);
    expect(snapshot.pages.some(page => page.properties.research_scope === "EU")).toBe(true);
    expect((await store.read(wiki.id, "Wiki.md")).content).toContain("research_index: jurisdictions");
    expect((await store.read(wiki.id, "AGENTS.md")).content).toContain("destination.createFolders: true");
    expect((await store.read(wiki.id, "User finding.md")).content).toContain("Keep this finding");
    const guidance = await store.read(wiki.id, "AGENTS.md");
    await store.write(wiki.id, "AGENTS.md", "# My own organization", guidance.revision);
    const removed = snapshot.pages.find(page => page.properties.research_scope === "DE")!;
    await store.remove(wiki.id, removed.path, removed.revision);
    expect((await store.ensureLegalResearch(language === "de" ? "en" : "de", "US")).updated).toBe(false);
    expect((await store.read(wiki.id, "AGENTS.md")).content).toBe("# My own organization");
    expect((await store.snapshot(wiki.id)).pages.some(page => page.properties.research_scope === "US")).toBe(false);
    await expect(store.read(wiki.id, removed.path)).rejects.toMatchObject({ status: 404 });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("late country selection and migration preserve custom home, instructions and unrelated navigation", async () => {
  const { root, config } = await fixture(), store = new WikiStore(config);
  try {
    const wiki = (await store.ensureLegalResearch("en")).wiki!;
    for (const path of ["Wiki.md", "AGENTS.md", "By area of law.md"]) {
      const current = await store.read(wiki.id, path);
      await store.write(wiki.id, path, "# Custom " + path, current.revision);
    }
    const db = await openSqlite(join(store.baseDir, "wiki-state.sqlite"));
    try { db.run("DELETE FROM wiki_research_structure"); } finally { db.close(); }
    await store.ensureLegalResearch("en");
    await store.ensureLegalResearch("de", "GB");
    for (const path of ["Wiki.md", "AGENTS.md", "By area of law.md"]) expect((await store.read(wiki.id, path)).content).toBe("# Custom " + path);
    const pages = (await store.snapshot(wiki.id)).pages;
    expect(pages.some(page => page.path === "Jurisdictions/United Kingdom/Wiki.md")).toBe(true);
    expect(pages.some(page => page.properties.research_scope === "EU")).toBe(false);
    for (const id of ["GB-EAW", "GB-SCT", "GB-NIR"]) expect(pages.some(page => page.properties.research_scope === id)).toBe(true);
    expect(researchIndexGroups(pages, "areas").size).toBe(0);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("folder proposals stay outside the wiki until Save, retain revision checks and reject unsafe or unrelated destinations", async () => {
  const { root, config } = await fixture(), store = new WikiStore(config);
  const wiki = (await store.ensureLegalResearch("en", "US")).wiki!;
  const ordinary = await store.create({ name: "Ordinary" });
  const server = await startServer(config), url = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const base = "/workspace/project/wiki-suggestions";
  const input = { title: "Synthetic finding", content: "---\ntype: legal-research\njurisdictions: [US-DE]\nprimary_area: corporate\nareas: [finance]\n---\n# Synthetic finding", destination: { wikiId: wiki.id, path: "Jurisdictions/United States/Delaware/Corporate/Finding.md", baseRevision: null, createFolders: true } };
  try {
    expect((await post(base, { ...input, destination: { ...input.destination, createFolders: false } })).status).toBe(400);
    expect((await post(base, { ...input, destination: { ...input.destination, wikiId: ordinary.id } })).status).toBe(400);
    expect((await post(base, { ...input, destination: { ...input.destination, path: "../escape.md" } })).status).toBe(400);
    const draft = await (await post(base, input)).json();
    expect((await store.snapshot(wiki.id)).folders).not.toContain("Jurisdictions/United States/Delaware");
    expect((await post(`${base}/${draft.id}/save`, { revision: "stale" })).status).toBe(409);
    expect((await post(`${base}/${draft.id}/dismiss`, { revision: draft.revision })).status).toBe(200);
    expect((await store.snapshot(wiki.id)).folders).not.toContain("Jurisdictions/United States/Delaware");
    const ready = await (await post(base, input)).json();
    expect((await post(`${base}/${ready.id}/save`, { revision: ready.revision })).status).toBe(200);
    const snapshot = await store.snapshot(wiki.id);
    expect(researchIndexGroups(snapshot.pages, "areas").get("corporate")?.[0].path).toBe(input.destination.path);
    expect(researchIndexGroups(snapshot.pages, "areas").get("finance")?.[0].path).toBe(input.destination.path);
    expect(researchIndexGroups(snapshot.pages, "jurisdictions").get("US-DE")).toHaveLength(1);
    const conflict = await (await post(base, input)).json();
    expect((await post(`${base}/${conflict.id}/save`, { revision: conflict.revision })).status).toBe(409);
    await symlink(root, join(wiki.root, "Unsafe"));
    const unsafe = await (await post(base, { ...input, destination: { ...input.destination, path: "Unsafe/nested/outside.md" } })).json();
    expect((await post(`${base}/${unsafe.id}/save`, { revision: unsafe.revision })).status).toBe(403);
  } finally { await server.stop(); await store.close(); await rm(root, { recursive: true, force: true }); }
});


test.each(["en", "de"] satisfies Array<"en" | "de">)("%s v2 guidance upgrades to automatic research capture while preserving edits", async language => {
  const { root, config } = await fixture();
  const store = new WikiStore(config);
  try {
    const wiki = (await store.ensureLegalResearch(language, "DE")).wiki!;
    const legacy = JSON.parse(await readFile(new URL("./fixtures/legal-research-v2.json", import.meta.url), "utf8"));
    for (const path of ["Wiki.md", "AGENTS.md"]) await writeFile(join(wiki.root, path), legacy[language][path]);
    const db = await openSqlite(join(store.baseDir, "wiki-state.sqlite"));
    try { db.run("UPDATE wiki_research_structure SET version=2 WHERE wiki=?", [wiki.id]); } finally { db.close(); }
    expect((await store.ensureLegalResearch(language)).updated).toBe(true);
    expect((await store.read(wiki.id, "AGENTS.md")).content).toContain(legalResearchCaptureGuidance);
    // Earlier v2 builds had the same instructions before source attachments shipped.
    await writeFile(join(wiki.root, "AGENTS.md"), legacy[language]["AGENTS-before-attachments.md"]);
    const earlier = await openSqlite(join(store.baseDir, "wiki-state.sqlite"));
    try { earlier.run("UPDATE wiki_research_structure SET version=2 WHERE wiki=?", [wiki.id]); } finally { earlier.close(); }
    await store.ensureLegalResearch(language);
    expect((await store.read(wiki.id, "AGENTS.md")).content).toContain(legalResearchCaptureGuidance);
    const guidance = await store.read(wiki.id, "AGENTS.md");
    await store.write(wiki.id, "AGENTS.md", legacy[language]["AGENTS.md"] + "\nCustom firm instructions.\n", guidance.revision);
    const next = await openSqlite(join(store.baseDir, "wiki-state.sqlite"));
    try { next.run("UPDATE wiki_research_structure SET version=2 WHERE wiki=?", [wiki.id]); } finally { next.close(); }
    await store.ensureLegalResearch(language);
    expect((await store.read(wiki.id, "AGENTS.md")).content).toBe(legacy[language]["AGENTS.md"] + "\nCustom firm instructions.\n");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});


test("the generated research wiki migrates an absent approval default but preserves an explicit choice", async () => {
  const { root, config } = await fixture();
  const store = new WikiStore(config);
  try {
    const wiki = (await store.ensureLegalResearch("en")).wiki!;
    // Simulate a pre-setting registration without changing content or identity.
    await writeFile(store.path, (await readFile(store.path, "utf8")).replace(/^[ \t]*requireAgentApproval: false\r?\n/m, ""));
    expect((await store.get(wiki.id)).requireAgentApproval).toBeUndefined();
    expect((await store.ensureLegalResearch("en")).wiki?.requireAgentApproval).toBe(false);
    await store.update(wiki.id, { requireAgentApproval: true });
    expect((await store.ensureLegalResearch("en")).wiki?.requireAgentApproval).toBe(true);
    expect((await store.create({ name: "Manual research", template: "legal-research" })).requireAgentApproval).toBe(true);
    expect((await store.create({ name: "Knowledge", template: "blank" })).requireAgentApproval).toBe(true);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
