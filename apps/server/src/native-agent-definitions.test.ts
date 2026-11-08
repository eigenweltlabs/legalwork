import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@opencode/schema/agent";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import { coreManifest, rememberCoreManifest } from "./core-bundle.js";
import { resolveNativeAgentDefinitions } from "./native-agent-definitions.js";
import { foldNativeAgents } from "./opencode-plugins/managed-native-agents.js";
import { resolveNativeCommandDefinitions } from "./native-command-definitions.js";

test("native agent declarations retain order, variants, permissions, primary modes, disabled roles and linked libraries", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-agents-"));
  try {
    for (const path of ["agent/nested", "agents", "modes/nested", "external"]) await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, "agent/same.md"), "---\nmode: subagent\n---\nFirst\n");
    await writeFile(join(root, "agents/same.md"), "---\nmodel: fixture/model\nvariant: deep\npermissions:\n  - action: edit\n    resource: ~/blocked/*\n    effect: deny\nrequest:\n  body:\n    temperature: 0.2\n---\nNative project instructions\n");
    await writeFile(join(root, "agent/nested/legacy.md"), "---\nmode: subagent\nmodel: fixture/model\nvariant: low\ntemperature: 0.3\ntop_p: 0.8\noptions:\n  seed: 42\npermission:\n  read: deny\n---\nLegacy instructions\n");
    await writeFile(join(root, "modes/primary.md"), "---\nmode: subagent\n---\nPrimary mode\n");
    await writeFile(join(root, "modes/nested/ignored.md"), "Nested modes are not discovered\n");
    await writeFile(join(root, "agents/bad.md"), "---\nmode: invalid\n---\nInvalid\n");
    await writeFile(join(root, "external/helper.md"), "External instructions\n");
    await symlink(join(root, "external"), join(root, "agents/linked"), "dir");
    await symlink(join(root, "agents"), join(root, "agents/cycle"), "dir");
    const selected = await resolveNativeAgentDefinitions([
      { type: "document", info: { default_agent: "same", permissions: [{ action: "read", resource: "$HOME/private/*", effect: "ask" }], agents: { same: { system: "Global" }, retired: {} }, providers: { private: { settings: { apiKey: "private-provider-key" } } } } },
      { type: "directory", path: root },
      { type: "document", info: { agents: { retired: { disabled: true } } } },
    ], join(root, "private"));
    type Value = Parameters<Parameters<AgentEditor["update"]>[1]>[0];
    const agents = new Map<string, Value>(); let defaultID: string | undefined;
    const editor: AgentEditor = {
      list: () => [...agents.values()], get: id => agents.get(id), remove: id => { agents.delete(id); }, default: id => { defaultID = id; },
      update(id, update) {
        let value = agents.get(id);
        if (!value) { value = { ...Agent.Info.default(Agent.ID.make(id)), permissions: [], request: { settings: {}, body: {}, headers: {} } }; agents.set(id, value); }
        update(value);
      },
    };
    foldNativeAgents(editor, selected.documents);
    expect(JSON.stringify(selected.documents)).not.toContain("private-provider-key");
    expect(defaultID).toBe("same");
    expect(agents.get("same")).toMatchObject({ system: "Native project instructions", model: { providerID: "fixture", id: "model", variant: "deep" }, request: { body: { temperature: 0.2 } } });
    expect(agents.get("same")?.permissions).toEqual([
      { action: "read", resource: join(homedir(), "private/*"), effect: "ask" },
      { action: "edit", resource: join(homedir(), "blocked/*"), effect: "deny" },
    ]);
    expect(agents.get("nested/legacy")).toMatchObject({ mode: "subagent", model: { variant: "low" }, request: { body: { temperature: 0.3, top_p: 0.8, seed: 42 } }, permissions: expect.arrayContaining([{ action: "read", resource: "*", effect: "deny" }]) });
    expect(agents.get("primary")?.mode).toBe("primary");
    expect(agents.get("linked/helper")?.system).toBe("External instructions");
    for (const id of ["bad", "retired", "nested/ignored"]) expect(agents.has(id)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unchanged old agents and shortcuts use shared defaults; authored and unverified versions retain native precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-core-")), project = join(root, "project"), library = join(root, "library");
  const files = [ { path: ".opencode/agents/helper.md", content: "Old bundled agent\n" },
    { path: ".opencode/commands/shortcut.md", content: "Old bundled shortcut\n" } ];
  try {
    await mkdir(join(project, ".opencode/skills"), { recursive: true });
    for (const file of files) for (const directory of [project, library]) {
      await mkdir(dirname(join(directory, file.path)), { recursive: true }); await writeFile(join(directory, file.path), file.content);
    }
    const manifest = coreManifest(files);
    await rememberCoreManifest(library, manifest); await writeFile(join(project, ".opencode/.legalwork-core"), manifest.bundle);
    const entries = [{ type: "document", info: { agents: { helper: { system: "Shared agent" } }, commands: { shortcut: { template: "Shared shortcut" } } } },
      { type: "directory", path: join(project, ".opencode") }] satisfies Parameters<typeof resolveNativeAgentDefinitions>[0];
    expect((await resolveNativeAgentDefinitions(entries, library)).documents.flatMap(document => Object.values(document.agents ?? {}))).toEqual([expect.objectContaining({ system: "Shared agent" })]);
    const core = { root: library, commands: { shortcut: { template: "Shared shortcut" } } };
    expect((await resolveNativeCommandDefinitions(entries, core.commands, core)).commands.shortcut?.template).toBe("Shared shortcut");
    await writeFile(join(project, files[0]!.path), "My agent\n");
    await writeFile(join(project, files[1]!.path), "My shortcut\n");
    expect((await resolveNativeAgentDefinitions(entries, library)).documents.at(-1)?.agents?.helper?.system).toBe("My agent");
    expect((await resolveNativeCommandDefinitions(entries, core.commands, core)).commands.shortcut?.template).toBe("My shortcut");
    expect((await resolveNativeCommandDefinitions(entries, { shortcut: { template: "Saved app selection" } }, core)).commands.shortcut?.template).toBe("Saved app selection");
    await writeFile(join(project, ".opencode/.legalwork-core"), "unknown");
    await writeFile(join(project, files[0]!.path), files[0]!.content);
    expect((await resolveNativeAgentDefinitions(entries, library)).documents.at(-1)?.agents?.helper?.system).toBe("Old bundled agent");
  } finally { await rm(root, { recursive: true, force: true }); }
});
