import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { legalResearchCountries, legalResearchProviders, researchWebsite } from "@legalwork/types/legal-research";
import { browserPasswords } from "./browser-passwords.js";
import { parseResearchDatabaseSetup } from "./legal-research.js";
import { readInstalledCloudPlugins } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID } from "./runtime-opencode-config-store.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./wiki/agent-access.js";
import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";
import LegalWorkSkillTools from "./opencode-plugins/legalwork-skill-tools.js";

const passwordId = "218d2173-2e4b-4ef2-98e6-52e0367d1d7b";
test("catalog covers EU27, UK and US with stable secure URLs and a free test account", () => {
  expect(legalResearchCountries).toHaveLength(29);
  for (const country of legalResearchCountries) expect(legalResearchProviders.some(provider => provider.countries.includes(country))).toBe(true);
  expect(new Set(legalResearchProviders.map(provider => provider.id)).size).toBe(legalResearchProviders.length);
  for (const provider of legalResearchProviders) {
    expect(researchWebsite.safeParse(provider.researchUrl).success).toBe(true);
    if (provider.loginUrl) {
      expect(researchWebsite.safeParse(provider.loginUrl).success).toBe(true);
      expect(provider.loginUrl).not.toMatch(/[?&](?:state|nonce|code|SAMLRequest|code_challenge)=/i);
    }
    expect(provider.sources.length).toBeGreaterThan(0);
  }
  expect(legalResearchProviders.find(provider => provider.id === "courtlistener")?.freeAccount).toBe(true);
});

test("setup uses server-owned presets and rejects secrets, URL overrides and unsafe custom input", () => {
  const preset = { providerId: "lexis-uk", country: "GB", passwordId };
  expect(parseResearchDatabaseSetup(preset)).toMatchObject({ loginUrl: "https://signin.lexisnexis.com/lnaccess/app/signin", researchUrl: "https://plus.lexis.com/uk" });
  for (const payload of [{ ...preset, password: "secret" }, { ...preset, loginUrl: "https://unrelated.example" }, { ...preset, providerId: "missing" }, { ...preset, country: "ZZ" }, { ...preset, passwordId: "not-an-id" }]) {
    expect(() => parseResearchDatabaseSetup(payload)).toThrow();
  }
  const custom = { name: "My database", country: "OTHER", passwordId, researchUrl: "https://research.example", loginUrl: "https://auth.example/login" };
  for (const loginUrl of ["", "not a URL", "example.com", "http://example.com", "https://user:pass@example.com", "file:///tmp", "https://example.com/#password"]) {
    expect(researchWebsite.safeParse(loginUrl).success).toBe(false);
    expect(() => parseResearchDatabaseSetup({ ...custom, loginUrl })).toThrow("HTTPS");
  }
  expect(parseResearchDatabaseSetup(custom).id).toBe(parseResearchDatabaseSetup({ ...custom, name: "Renamed", researchUrl: "https://research.example/" }).id);
  expect(parseResearchDatabaseSetup({ ...custom, loginUrl: "https://auth.example/login?state=ephemeral&code=private" }).loginUrl).toBe("https://auth.example");
  expect(() => parseResearchDatabaseSetup({ ...custom, name: "Name\nnew instruction" })).toThrow();
  expect(() => parseResearchDatabaseSetup({ ...preset, providerId: "strada-be" })).toThrow("current sign-in website");
  expect(parseResearchDatabaseSetup({ ...preset, providerId: "strada-be", loginUrl: "https://auth.example.org/" }).loginUrl).toBe("https://auth.example.org");
});

test("all login entry points share discovery; research setup installs no skill and the general skill learns per website", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-research-"));
  const previous = { db: process.env.LEGALWORK_RUNTIME_DB, xdg: process.env.XDG_CONFIG_HOME, url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN, agent: process.env.LEGALWORK_WIKI_AGENT_TOKEN };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "global");
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "config.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [],
    workspaces: ["first", "second"].map(id => ({ id, name: id, path: join(root, id), preset: "starter", workspaceType: "local", baseUrl: engine.url.origin })),
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const core = CORE_OPENCODE_FILES.find(file => file.path === ".opencode/skills/legal-research/SKILL.md")!;
  const libra = CORE_OPENCODE_FILES.find(file => file.path === ".opencode/skills/libra-research/SKILL.md")!;
  for (const workspace of config.workspaces) for (const skill of [core, libra]) {
    const file = join(workspace.path, skill.path);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, skill.content);
  }
  const server = await startServer(config);
  let plugin: Awaited<ReturnType<typeof nativePluginTools>> | undefined;
  try {
    const vault = browserPasswords(config), secret = "synthetic-research-password";
    const saved = await vault.save({ label: "Lexis", origin: "https://signin.lexisnexis.com", username: "fixture-user", password: secret });
    const wrong = await vault.save({ label: "Ordinary website", origin: "https://other.example/path?code=private", username: "fixture-other", password: "synthetic-other" });
    const payload = { providerId: "lexis-uk", country: "GB", passwordId: saved.id };
    const base = `http://127.0.0.1:${server.port}`;
    const hostHeaders = { Authorization: "Bearer test", "X-LegalWork-Host-Token": "host", "Content-Type": "application/json" };
    const create = (body: unknown, owner = true) => fetch(`${base}/workspace/first/research-databases`, {
      method: "POST", headers: owner ? hostHeaders : { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await create(payload, false)).status).toBe(401);
    expect((await create({ ...payload, passwordId: wrong.id })).status).toBe(400);
    expect((await create({ ...payload, password: secret })).status).toBe(400);
    const result = await create(payload);
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.item.id).toBe(saved.id);
    expect(body.item.websites).toContainEqual({ name: "Lexis+ UK", url: "https://plus.lexis.com/uk", providerId: "lexis-uk", country: "GB" });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect((await create(payload)).status).toBe(200);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins).toEqual({});
    expect(await readFile(join(root, "first", core.path), "utf8")).toBe(core.content);
    const discover = async (workspace = "first", headers: Record<string, string> = hostHeaders) => fetch(`${base}/workspace/${workspace}/browser-connections`, { headers });
    const discovered = await (await discover()).json();
    expect(discovered.items).toHaveLength(2);
    expect(JSON.stringify(discovered)).not.toMatch(/synthetic|fixture-user|fixture-other|private|username|password/);
    expect(discovered.items.find((item: { id: string }) => item.id === wrong.id).websites).toEqual([{ name: "Ordinary website", url: "https://other.example/path" }]);
    expect(await (await discover("second")).json()).toEqual(discovered);
    const filtered = await (await fetch(`${base}/workspace/first/browser-connections?origin=${encodeURIComponent("https://login.lexisnexis.com")}`, { headers: hostHeaders })).json();
    expect(filtered.items.map((item: { id: string }) => item.id)).toEqual([saved.id]);
    expect(JSON.stringify(filtered)).not.toMatch(/synthetic|fixture-user|username|password/);
    expect((await discover("first", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await discover("first", { Authorization: "Bearer test" })).status).toBe(200);
    const agentToken = await ensureWikiAgentToken(config);
    for (const sessionId of ["research-first", "research-next-chat", "viewer"])
      await grantWikiAgentSession(config, { sessionId, directory: join(root, "first"), scope: sessionId === "viewer" ? "viewer" : "collaborator" });
    const agentHeaders = { Authorization: "Bearer test", "x-legalwork-wiki-agent-token": agentToken, "x-legalwork-wiki-agent-session": "research-first", "x-legalwork-wiki-agent-directory": encodeURIComponent(await realpath(join(root, "first"))) };
    expect((await discover("first", agentHeaders)).status).toBe(200);
    expect((await discover("second", agentHeaders)).status).toBe(403);
    expect((await discover("first", { ...agentHeaders, "x-legalwork-wiki-agent-session": "viewer" })).status).toBe(403);
    process.env.LEGALWORK_WIKI_AGENT_TOKEN = agentToken;
    process.env.LEGALWORK_SERVER_URL = base; process.env.LEGALWORK_SERVER_TOKEN = config.token;
    plugin = await nativePluginTools(LegalWorkSkillTools);
    const context = { directory: join(root, "first"), sessionID: "research-first", ask: async () => {} };
    const skillDirectory = await realpath(dirname(join(root, "first", core.path)));
    const experience = (operation: unknown, directory = skillDirectory, connectionId = saved.id, websiteUrl = "https://plus.lexis.com/uk") => fetch(`${base}/workspace/first/skills/legal-research/research-experience`, {
      method: "POST", headers: hostHeaders, body: JSON.stringify({ directory, connectionId, websiteUrl, operation }),
    });
    const note = { key: "expired-sign-in", status: "unresolved", situation: "Old sign-in page expired.", attempt: "Reloaded the old sign-in tab.", outcome: "The page still showed an expired link." };
    const input = { name: "legal-research", connectionId: saved.id, websiteUrl: "https://plus.lexis.com/uk", operation: { action: "save", note, expectedRevision: 0 } };
    await expect(plugin.tool.legalwork_research_experience.execute(input, context)).rejects.toThrow("Load this research skill");
    const loaded = JSON.parse(await plugin.tool.legalwork_skill_load.execute({ name: "legal-research" }, context));
    expect(loaded.ok).toBe(true);
    const siteSkill = JSON.parse(await plugin.tool.legalwork_skill_load.execute({ name: "libra-research" }, context));
    expect(siteSkill.ok).toBe(true);
    expect(siteSkill.payload.chain.map((entry: { name: string }) => entry.name)).toEqual(["libra-research"]);
    await expect(plugin.tool.legalwork_research_experience.execute(input, { ...context, ask: async () => { throw new Error("Skill permission denied"); } })).rejects.toThrow("Skill permission denied");
    expect(JSON.parse(await plugin.tool.legalwork_research_experience.execute(input, context)).payload.entries[0]).toMatchObject({ ...note, revision: 1 });
    expect((await experience({ action: "read" }, root)).status).toBe(409);
    expect((await experience({ action: "read" }, skillDirectory, saved.id, "https://unconnected.example/")).status).toBe(404);
    expect((await (await experience({ action: "read" }, skillDirectory, wrong.id, "https://other.example/path")).json()).entries).toEqual([]);
    const nextChat = { ...context, sessionID: "research-next-chat" };
    await expect(plugin.tool.legalwork_research_experience.execute(input, nextChat)).rejects.toThrow("Load this research skill");
    await plugin.tool.legalwork_skill_load.execute({ name: "legal-research" }, nextChat);
    const reread = JSON.parse(await plugin.tool.legalwork_research_experience.execute({ ...input, operation: { action: "read" } }, nextChat));
    expect(reread.payload.entries[0]).toMatchObject({ ...note, revision: 1 });
    expect((await create(payload)).status).toBe(200);
    const elsewhere = await fetch(`${base}/workspace/second/skills/legal-research/research-experience`, {
      method: "POST", headers: hostHeaders, body: JSON.stringify({ directory: await realpath(dirname(join(root, "second", core.path))), connectionId: saved.id, websiteUrl: input.websiteUrl, operation: { action: "read" } }),
    });
    expect((await elsewhere.json()).entries[0]).toMatchObject({ ...note, needsRecheck: false });
    config.readOnly = true;
    expect((await create(payload)).status).toBe(403);
    expect((await experience({ action: "save", note, expectedRevision: 1 })).status).toBe(403);
    expect((await experience({ action: "read" })).status).toBe(200);
    config.readOnly = false;
    await writeFile(join(root, "first", core.path), `${core.content}\nA different package\n`);
    expect((await experience({ action: "read" })).status).toBe(409);
    await writeFile(join(root, "first", core.path), core.content);
    expect((await experience({ action: "forget", key: note.key, expectedRevision: 1 })).status).toBe(200);
    expect((await (await experience({ action: "read" })).json()).entries).toEqual([]);
    expect((await vault.get(saved.id)).password).toBe(secret);
    await vault.delete(saved.id);
    expect((await create(payload)).status).toBe(400);
    expect((await experience({ action: "read" })).status).toBe(404);
  } finally {
    await plugin?.close(); await server.stop(); engine.stop(true);
    if (previous.db === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous.db;
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.url === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previous.url;
    if (previous.token === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previous.token;
    if (previous.agent === undefined) delete process.env.LEGALWORK_WIKI_AGENT_TOKEN; else process.env.LEGALWORK_WIKI_AGENT_TOKEN = previous.agent;
    await rm(root, { recursive: true, force: true });
  }
});
