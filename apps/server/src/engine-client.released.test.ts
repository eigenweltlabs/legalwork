import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineClient, getWorkspaceEngineSession, listEngineMessages, listEngineSessions, workspaceEngineLocation } from "./engine-client.js";
import { createSeededOpencodeSession } from "./opencode-db.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { resolveServerConfig } from "./config.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released native client follows all pages and rejects a session from another project", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-client-"));
  const names = ["home", "config", "data", "state", "cache", "first", "second"];
  await Promise.all(names.map(name => mkdir(join(root, name), { recursive: true })));
  const engine = await createManagedOpencodeServer({ bin: binary, cwd: root, timeoutMs: 30_000, env: {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_DIR: join(root, "config"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
  } });
  try {
    const config = await resolveServerConfig({ configPath: join(root, "server.json"), workspaces: [join(root, "first"), join(root, "second")], token: "fixture-client", hostToken: "fixture-host" });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    for (const workspace of config.workspaces) { workspace.baseUrl = engine.url; workspace.opencodeUsername = engine.username; workspace.opencodePassword = engine.password; }
    const [first, second] = config.workspaces;
    if (!first || !second) throw new Error("Both test projects are required");
    const client = createEngineClient(config, first);
    const sessions = await Promise.all(Array.from({ length: 53 }, (_, index) => client.session.create({ location: workspaceEngineLocation(first), title: `Page fixture ${index}` })));
    const other = await client.session.create({ location: workspaceEngineLocation(second), title: "Private second project" });
    const listed = await listEngineSessions(client, { directory: first.path });
    expect(new Set(listed.map(session => session.id))).toEqual(new Set(sessions.map(session => session.id)));
    expect((await listEngineSessions(client, { directory: first.path, limit: 2 })).length).toBe(2);
    expect((await getWorkspaceEngineSession(client, first, sessions[0].id)).location.directory).toBe(first.path);
    await expect(getWorkspaceEngineSession(client, first, other.id)).rejects.toMatchObject({ status: 404, code: "session_not_found" });
    await expect(getWorkspaceEngineSession(client, first, "ses_missing")).rejects.toMatchObject({ status: 404 });
    const messages = Array.from({ length: 55 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `Template ${index}\n${"Complete text. ".repeat(1200)}` })).map(message => ({ ...message, role: message.role === "user" ? "user" : "assistant" } satisfies { role: "user" | "assistant"; text: string }));
    const template = { client, workspaceRoot: first.path, workspaceId: first.id, templateId: "complete-template", title: "Seeded chat", messages };
    const seeded = await Promise.all([createSeededOpencodeSession(template), createSeededOpencodeSession(template)]);
    expect(seeded[0].id).toBe(seeded[1].id);
    const imported = await listEngineMessages(client, seeded[0].id);
    expect(imported.length).toBe(55);
    expect(imported[0].type === "user" ? imported[0].text : null).toBe(messages[0].text);
    expect(imported[53].type === "assistant" ? imported[53].content : null).toContainEqual({ type: "text", text: messages[53].text });
    expect(imported.every(message => message.metadata?.legalworkBlueprintSeed === true)).toBe(true);
    const changed = await createSeededOpencodeSession({ ...template, messages: [{ role: "user", text: "Must never replace existing history" }] });
    expect(changed.id).toBe(seeded[0].id);
    expect((await listEngineMessages(client, changed.id)).length).toBe(55);
    await expect(createSeededOpencodeSession({ ...template, workspaceRoot: second.path })).rejects.toThrow("belongs to another project");
    // No prompt is submitted and no model call is possible in this test.
    expect(await client.session.active()).toEqual({});
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
}, 45_000);
