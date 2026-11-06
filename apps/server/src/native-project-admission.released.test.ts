import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode, type JsonValue } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";

const rpc = { id: "legalwork.admission-probe", methods: { execute: {
  input: { type: "object", properties: { sessionID: { type: "string" }, tool: { type: "string" }, input: { type: "object" } }, required: ["sessionID", "tool", "input"] },
  output: { type: "string" },
} }, events: {} };

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("released native admission blocks internal unapproved MCP/plugin/file automation before host execution", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-project-admission-")));
  const untrusted = join(root, "untrusted"), trusted = join(root, "trusted"), guard = join(root, "guard"), probe = join(root, "probe");
  await Promise.all([untrusted, trusted, guard, probe, ...["home", "config", "data", "state", "cache"].map(name => join(root, name))].map(path => mkdir(path, { recursive: true })));
  await mkdir(join(untrusted, ".opencode", "plugins", "unknown"), { recursive: true });
  await mkdir(join(untrusted, ".claude"), { recursive: true });
  const registryPath = join(root, "projects.json"), mcpMarker = join(root, "mcp-executed"), pluginMarker = join(root, "plugin-imported"), formatterMarker = join(root, "formatter-executed");
  await writeFile(registryPath, JSON.stringify({ version: 1, projects: [{ directory: untrusted, approved: false }, { directory: trusted, approved: true }] }));
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-project-admission.ts", import.meta.url))], outdir: guard, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
  if (!build.success) throw new AggregateError(build.logs, "Admission fixture must build");
  await writeFile(join(probe, "index.js"), `import {Plugin} from '@opencode/plugin';export default Plugin.define({id:'legalwork.admission-probe',async setup(ctx){await ctx.rpc.register(${JSON.stringify(rpc)},{async execute(input){const tool=(await ctx.tool.list()).find(tool=>tool.name===input.tool);if(!tool)throw new Error('Tool unavailable');return JSON.stringify(await tool.execute(input.input,{sessionID:input.sessionID,messageID:'msg_admission',id:'call_admission',agent:'build',signal:new AbortController().signal,progress:async()=>{}}));}})}});`);
  await writeFile(join(untrusted, ".opencode", "plugins", "unknown", "index.js"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pluginMarker)},'unsafe');throw new Error('An unapproved plugin was imported');`);
  await writeFile(join(untrusted, "opencode.json"), JSON.stringify({ plugins: ["-legalwork.project-admission", "opencode.config.command"],
    policies: [{ action: "integration.use", resource: "plugin:*", effect: "allow" }],
    mcp: { servers: { probe: { type: "local", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)},'unsafe')`] } } },
    formatter: { fixture: { extensions: [".txt"], command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(formatterMarker)},'unsafe')`] } },
  }));
  const legacyMcp = { mcpServers: { legacy: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)},'unsafe')`] } } };
  await writeFile(join(untrusted, ".mcp.json"), JSON.stringify(legacyMcp));
  await writeFile(join(untrusted, ".claude", "settings.json"), JSON.stringify(legacyMcp));
  await writeFile(join(root, "config", "opencode.json"), JSON.stringify({ policies: [{ action: "integration.use", resource: "plugin:*", effect: "deny" },
    ...[guard, probe].map(target => ({ action: "integration.use", resource: `plugin:${target}`, effect: "allow" }))] }));
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    engine = await createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: root, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_CLAUDE_CODE: "0", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [probe, { package: guard, options: { registryPath } }, "-opencode.config.command"] }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: untrusted };
    await client.model.list({ location });
    await Bun.sleep(150);
    expect(existsSync(mcpMarker)).toBe(false); expect(existsSync(pluginMarker)).toBe(false);
    const plugins = (await client.plugin.list({ location })).data;
    expect((await client.mcp.list({ location })).data, JSON.stringify(plugins.filter(plugin => plugin.source.type !== "builtin"))).toEqual([]);
    expect(plugins.find(plugin => plugin.id === "legalwork.project-admission")?.state.status).toBe("active");
    expect(plugins.some(plugin => plugin.id === "opencode.config.command")).toBe(false);
    expect(plugins.find(plugin => plugin.id === "opencode.config.mcp")?.state.status).toBe("active");
    const session = await client.session.create({ location, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    await expect(client.session.prompt({ sessionID: session.id, text: "Must not run", resume: false })).rejects.toThrow();
    const invoke = (sessionID: string, tool: string, input: Record<string, JsonValue>, directory: string) => client.rpc.call({ rpcID: rpc.id, method: "execute", location: { directory }, input: { sessionID, tool, input } });
    await expect(invoke(session.id, "write", { path: join(untrusted, "file.txt"), content: "unsafe" }, untrusted)).rejects.toThrow();
    expect(existsSync(join(untrusted, "file.txt"))).toBe(false); expect(existsSync(formatterMarker)).toBe(false);
    // The authenticated native file API is a trusted-client primitive, not a
    // model tool. It writes bytes directly and never invokes formatters; the
    // LegalWork proxy independently requires project admission before it.
    await client.file.write({ location, path: join(untrusted, "client-file.txt"), payload: new TextEncoder().encode("trusted client") });
    expect(existsSync(join(untrusted, "client-file.txt"))).toBe(true);
    expect(existsSync(formatterMarker)).toBe(false);
    await client.model.list({ location: { directory: trusted } });
    const allowed = await client.session.create({ location: { directory: trusted }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    await invoke(allowed.id, "write", { path: join(trusted, "file.txt"), content: "approved" }, trusted);
    expect(existsSync(join(trusted, "file.txt"))).toBe(true);
    // Automatic admission covers the exact application-owned native file,
    // without making the surrounding folder's future automation trusted.
    const generated = join(root, "generated"), generatedDirectory = join(generated, ".opencode");
    await mkdir(generatedDirectory, { recursive: true });
    const generatedPath = join(generatedDirectory, "opencode.json"), ownedMarker = join(root, "owned-mcp-executed"), editedMarker = join(root, "edited-mcp-executed");
    const owned = JSON.stringify({ mcp: { servers: { owned: { type: "local", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(ownedMarker)},'approved')`] } } } });
    await writeFile(generatedPath, owned);
    await writeFile(registryPath, JSON.stringify({ version: 1, projects: [{ directory: untrusted, approved: false }, { directory: trusted, approved: true },
      { directory: generated, approved: true, generated: { scopes: [generated, root], documents: [{ path: generatedPath, digest: createHash("sha256").update(owned).digest("hex") }] } }] }));
    await client.model.list({ location: { directory: generated } });
    for (let attempt = 0; attempt < 200 && !existsSync(ownedMarker); attempt++) await Bun.sleep(10);
    expect(existsSync(ownedMarker)).toBe(true);
    await writeFile(generatedPath, JSON.stringify({ mcp: { servers: { edited: { type: "local", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(editedMarker)},'unsafe')`] } } } }));
    await client.location.reload();
    await client.model.list({ location: { directory: generated } });
    await Bun.sleep(150);
    expect(existsSync(editedMarker)).toBe(false);
    expect((await client.mcp.list({ location: { directory: generated } })).data).toEqual([]);
    // Positive control: the identical authored MCP configuration executes
    // only after approval. A fixture command that exits still proves startup.
    await writeFile(registryPath, JSON.stringify({ version: 1, projects: [{ directory: untrusted, approved: true }, { directory: trusted, approved: true }] }));
    expect(await client.session.active()).toEqual({});
    await client.location.reload();
    await client.model.list({ location });
    for (let attempt = 0; attempt < 200 && !existsSync(mcpMarker); attempt++) await Bun.sleep(10);
    expect(existsSync(mcpMarker)).toBe(true);
    expect(existsSync(pluginMarker)).toBe(false);
  } finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
