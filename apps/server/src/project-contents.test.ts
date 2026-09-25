import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./task-store.js";
import { listProjectContents, readProjectContent, type ProjectContentSources } from "./project-contents.js";
import { updateProjectDetails, readProjectDetails } from "./project-store.js";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup(): Promise<ProjectContentSources> {
  const root = await mkdtemp(join(tmpdir(), "project-contents-"));
  roots.push(root);
  const path = join(root, "project");
  await mkdir(join(path, "Notes"), { recursive: true });
  return {
    workspace: { id: "ws-project", name: "Original", displayName: "Renamed project", path, preset: "default", workspaceType: "local" },
    tasks: await TaskStore.open(join(root, "tasks.sqlite"), join(root, "attachments")),
    orgId: null,
    sessions: async () => [],
  };
}
const actor = { userId: null, name: null, email: null };

test("overview scopes linked tasks and includes note previews, files, sessions and recording availability", async () => {
  const sources = await setup();
  sources.tasks.createTask({ title: "Included", description: "Draft this", projectId: sources.workspace.id }, actor);
  sources.tasks.createTask({ title: "Other matter", projectId: "elsewhere" }, actor);
  sources.tasks.createTask({ title: "Unassigned" }, actor);
  await writeFile(join(sources.workspace.path, "Notes", "Opinion-abcdef12.md"), "# Opinion\n\nA preview of the note.");
  await writeFile(join(sources.workspace.path, "contract.pdf"), "PDF");
  await writeFile(join(sources.workspace.path, ".private"), "hidden");
  sources.sessions = async () => [
    { id: "s1", title: "Current chat", directory: sources.workspace.path, time: { updated: 100 } },
    { id: "s2", title: "Private other chat", directory: "/other", time: { updated: 99 } },
  ];
  const result = await listProjectContents(sources, {});
  expect(result.project.name).toBe("Renamed project");
  expect(result.sections.find((section) => section.kind === "tasks")?.items.map((item) => item.title)).toEqual(["Included"]);
  expect(result.sections.find((section) => section.kind === "notes")?.items[0]).toMatchObject({ title: "Opinion", preview: expect.stringContaining("A preview") });
  expect(result.sections.find((section) => section.kind === "files")?.items.map((item) => item.title)).toEqual(["Notes", "contract.pdf"]);
  expect(result.sections.find((section) => section.kind === "recordings")?.unavailable).toBe(true);
  expect(result.sections.find((section) => section.kind === "sessions")?.items.map((item) => item.id)).toEqual(["s1"]);
});

test("file and task pagination cover all entries without leaking another project's tasks", async () => {
  const sources = await setup();
  for (let i = 0; i < 5; i++) {
    await writeFile(join(sources.workspace.path, "Notes", `Note ${i}.md`), `# Note ${i}`);
    sources.tasks.createTask({ title: `Task ${i}`, projectId: sources.workspace.id }, actor, i + 1);
  }
  for (const kind of ["tasks", "notes"]) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await listProjectContents(sources, { kind, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(result.sections[0].unavailable).toBeUndefined();
      ids.push(...result.sections[0].items.map((item) => item.id));
      cursor = result.sections[0].nextCursor;
    } while (cursor);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
  }
});

test("reads reject outside-project tasks, hidden paths, traversal and escaping symlinks", async () => {
  const sources = await setup();
  const other = sources.tasks.createTask({ title: "Other", projectId: "other" }, actor);
  await expect(readProjectContent(sources, { kind: "tasks", id: other.id })).rejects.toThrow("not attached");
  await writeFile(join(sources.workspace.path, ".secret"), "do not read");
  await writeFile(join(sources.workspace.path, "..", "outside.txt"), "do not read");
  await symlink(join(sources.workspace.path, "..", "outside.txt"), join(sources.workspace.path, "escape.txt"));
  for (const id of ["../outside.txt", ".secret", "escape.txt", "/etc/passwd"]) {
    await expect(readProjectContent(sources, { kind: "files", id })).rejects.toThrow();
  }
  const own = sources.tasks.createTask({ title: "Own task", description: "Task detail", projectId: sources.workspace.id }, actor);
  expect((await readProjectContent(sources, { kind: "tasks", id: own.id })).content).toContain("Task detail");
});

test("long note and transcript reads carry continuation and reject unlinked recordings", async () => {
  const sources = await setup();
  const content = "a".repeat(13000);
  await writeFile(join(sources.workspace.path, "Notes", "Long.md"), content);
  const first = await readProjectContent(sources, { kind: "notes", id: "Notes/Long.md" });
  const second = await readProjectContent(sources, { kind: "notes", id: "Notes/Long.md", offset: first.nextOffset });
  expect(first.content + second.content).toBe(content);
  expect(second.nextOffset).toBeNull();
  sources.recorder = {
    status: () => ({ available: true, recordingActive: false, liveTranscriptActive: false, fileName: null, error: null }),
    setLiveTranscript: () => ({ available: true, recordingActive: false, liveTranscriptActive: false, fileName: null, error: null }),
    listProjectRecordings: async (projectId) => projectId === sources.workspace.id ? [{ id: "linked", title: "Call", durationMs: 1200, segmentCount: 1, status: "complete" }] : [],
    readProjectRecording: async (projectId, id) => projectId === sources.workspace.id && id === "linked" ? { segments: [{ id: "s", startMs: 1000, endMs: 1200, text: "Meeting text", final: true }] } : null,
  };
  expect((await listProjectContents(sources, { kind: "recordings" })).sections[0].items[0].title).toBe("Call");
  expect((await readProjectContent(sources, { kind: "recordings", id: "linked" })).content).toBe("[1s] Meeting text");
  await expect(readProjectContent(sources, { kind: "recordings", id: "unlinked" })).rejects.toThrow("not attached");
});

test("metadata label provenance survives a project save and reopen", async () => {
  const { workspace } = await setup();
  await updateProjectDetails(workspace.path, { revision: 0, fields: [
    { id: "client", label: "Mandant", labelSource: "suggested", type: "text", value: "Example" },
    { id: "own", label: "Mandant", labelSource: "custom", type: "text", value: null },
  ] });
  const fields = (await readProjectDetails(workspace.path)).fields;
  expect(fields.map((field) => field.labelSource)).toEqual(["suggested", "custom"]);
  expect(fields[0].value).toBe("Example");
});
