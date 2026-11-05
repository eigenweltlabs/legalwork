import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAssistantReport } from "./assistant-reports.js";
import { ViewRepository, workspaceViewFiles } from "./views/repository.js";
import { ViewInputSchema, parseViewReference } from "./views/schema.js";

test("Assistant reports persist once, embed by exact identity, and protect edits on retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-report-"));
  const workspace = { id: "assistant", path: root };
  const input = ViewInputSchema.parse({ version: 1, catalog: "legalwork-1", mode: "report", title: "Morning briefing", queries: {}, program: 'root = Text("Two priorities")' });
  const args = { key: "morning-briefing-2026-10-28", input };
  try {
    const [first, retry] = await Promise.all([saveAssistantReport(workspace, args), saveAssistantReport(workspace, args)]);
    expect(retry).toEqual(first);
    const repository = new ViewRepository(first.view.owner, workspaceViewFiles(root));
    expect((await repository.list()).items).toHaveLength(1);
    expect(await repository.read(first.view.id)).toEqual(first.view);
    expect(parseViewReference(first.reference)).toEqual({ owner: first.view.owner, viewId: first.view.id });
    expect(first.markdown).toBe(`\`\`\`legalwork-view\n${first.reference}\n\`\`\``);
    const changed = { ...args, input: { ...input, title: "Updated priorities" } };
    await expect(saveAssistantReport(workspace, changed)).rejects.toMatchObject({ status: 409 });
    const update = await saveAssistantReport(workspace, { ...changed, baseRevision: first.view.revision });
    expect(update.path).toBe(first.path);
    expect(update.view.title).toBe("Updated priorities");
    await expect(saveAssistantReport(workspace, { ...args, baseRevision: first.view.revision })).rejects.toMatchObject({ status: 409 });
    expect(await saveAssistantReport(workspace, { ...changed, baseRevision: first.view.revision })).toEqual(update);
    await expect(saveAssistantReport(workspace, { ...args, key: "new", baseRevision: "missing" })).rejects.toMatchObject({ status: 409 });
    await expect(saveAssistantReport(workspace, { ...args, key: "../escape" })).rejects.toThrow();
    await expect(saveAssistantReport(workspace, { ...args, key: "unsafe", input: { ...input, program: '<script>alert(1)</script>' } })).rejects.toMatchObject({ status: 400 });
    expect((await repository.list()).items).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
