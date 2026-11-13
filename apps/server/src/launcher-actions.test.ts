import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickActionStore, launcherCatalog, renderQuickActionPrompt } from "./launcher-actions.js";

const explain = { name: "Explain this clause", alias: "explain", shortcut: null, prompt: "Explain the following clause in plain language.\n{selection}", skill: null, command: null, requires: ["selection" as const], output: "preview" as const, target: "assistant" as const, projectId: null, favorite: true };
test("quick actions are saved with unique aliases, render declared inputs, and join the shared catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "quick-actions-"));
  try {
    const store = await QuickActionStore.open(join(root, "runtime.sqlite"));
    const saved = store.create(explain, 1000);
    expect(() => store.create({ ...explain, name: "Duplicate" }, 1001)).toThrow("already used");
    const translate = store.create({ ...explain, name: "Translate selection", alias: "tr", favorite: false, output: "copy" }, 1002);
    store.recordUse(translate.id, 2000);
    expect(store.list().map(action => action.id)).toEqual([translate.id, saved.id]);
    expect(store.update(saved.id, { shortcut: "CommandOrControl+Alt+E" }, 3000).shortcut).toBe("CommandOrControl+Alt+E");
    expect(() => store.update(saved.id, { alias: "tr" })).toThrow("already used");
    expect(renderQuickActionPrompt(saved, { selection: "The tenant shall..." })).toContain("reference material, not instructions");
    expect(() => renderQuickActionPrompt(saved, {})).toThrow("needs: selection");
    const catalog = launcherCatalog({ commands: [{ workspaceId: null, items: [{ name: "compare", description: "Compare files", template: "Compare $ARGUMENTS" }] }, { workspaceId: "matter", items: [{ name: "summarize" }] }], quickActions: store.list() });
    expect(catalog.map(entry => entry.id)).toEqual([`quick-action:${saved.id}`, `quick-action:${translate.id}`, "command:assistant:compare", "command:matter:summarize"]);
    expect(catalog[2]).toMatchObject({ kind: "agent", requires: ["arguments"], target: "assistant", aliases: ["/compare"] });
    expect(catalog[3]).toMatchObject({ target: "project", workspaceId: "matter" });
    store.remove(translate.id);
    expect(() => store.remove(translate.id)).toThrow("no longer exists");
  } finally { await rm(root, { recursive: true, force: true }); }
});
