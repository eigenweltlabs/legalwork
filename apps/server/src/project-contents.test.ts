import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./task-store.js";
import {
  listProjectContents,
  readProjectContent,
  type ProjectContentSources,
} from "./project-contents.js";
import { updateProjectDetails, readProjectDetails } from "./project-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function setup(): Promise<ProjectContentSources> {
  const root = await mkdtemp(join(tmpdir(), "project-contents-"));
  roots.push(root);
  const path = join(root, "project");
  await mkdir(join(path, "Notes"), { recursive: true });
  return {
    workspace: {
      id: "ws-project",
      name: "Original",
      displayName: "Renamed project",
      path,
      preset: "default",
      workspaceType: "local",
    },
    tasks: await TaskStore.open(
      join(root, "tasks.sqlite"),
      join(root, "attachments"),
    ),
    orgId: null,
    sessions: async () => [],
    session: async () => {
      throw new Error("Chat not found");
    },
    sessionMessages: async (id) => ({
      sessionID: id,
      messages: [],
      nextBefore: null,
    }),
  };
}
const actor = { userId: null, name: null, email: null };

test("overview scopes linked tasks and includes note previews, files, sessions and recording availability", async () => {
  const sources = await setup();
  sources.tasks.createTask(
    {
      title: "Included",
      description: "Draft this",
      projectId: sources.workspace.id,
    },
    actor,
  );
  sources.tasks.createTask(
    { title: "Other matter", projectId: "elsewhere" },
    actor,
  );
  sources.tasks.createTask({ title: "Unassigned" }, actor);
  await writeFile(
    join(sources.workspace.path, "Notes", "Opinion-abcdef12.md"),
    "# Opinion\n\nA preview of the note.",
  );
  await writeFile(join(sources.workspace.path, "contract.pdf"), "PDF");
  await writeFile(join(sources.workspace.path, ".private"), "hidden");
  sources.sessions = async () => [
    {
      id: "s1",
      title: "Current chat",
      location: { directory: sources.workspace.path },
      time: { created: 0, updated: 100 },
    },
    {
      id: "s2",
      title: "Private other chat",
      location: { directory: "/other" },
      time: { created: 0, updated: 99 },
    },
  ];
  const result = await listProjectContents(sources, {});
  expect(result.project.name).toBe("Renamed project");
  expect(
    result.sections
      .find((section) => section.kind === "tasks")
      ?.items.map((item) => item.title),
  ).toEqual(["Included"]);
  expect(
    result.sections.find((section) => section.kind === "notes")?.items[0],
  ).toMatchObject({
    title: "Opinion",
    preview: expect.stringContaining("A preview"),
  });
  expect(
    result.sections
      .find((section) => section.kind === "files")
      ?.items.map((item) => item.title),
  ).toEqual(["Notes", "contract.pdf"]);
  expect(
    result.sections.find((section) => section.kind === "recordings")
      ?.unavailable,
  ).toBe(true);
  expect(
    result.sections
      .find((section) => section.kind === "sessions")
      ?.items.map((item) => item.id),
  ).toEqual(["s1"]);
});

test("chat reads verify project ownership before fetching messages", async () => {
  const sources = await setup();
  let reads = 0;
  sources.sessionMessages = async (id) => {
    reads++;
    return { sessionID: id, messages: [], nextBefore: null };
  };
  for (const session of [
    {
      id: "chat",
      location: { directory: "/other-project" },
      time: { created: 0, updated: 1 },
    },
    {
      id: "chat",
      location: { directory: sources.workspace.path },
      time: { created: 0, updated: 1, archived: 2 },
    },
    {
      id: "wrong-chat",
      location: { directory: sources.workspace.path },
      time: { created: 0, updated: 1 },
    },
  ]) {
    sources.session = async () => ({ ...session, title: "Fixture" });
    await expect(
      readProjectContent(sources, { kind: "sessions", id: "chat" }),
    ).rejects.toThrow("not attached");
  }
  expect(reads).toBe(0);
});

test("chat reads paginate text and older messages without reasoning or tool output", async () => {
  const sources = await setup();
  sources.session = async (id) => ({
    id,
    title: "Fixture chat",
    location: { directory: sources.workspace.path },
    time: { created: 0, updated: 1 },
  });
  const messages: Awaited<
    ReturnType<ProjectContentSources["sessionMessages"]>
  >["messages"] = Array.from({ length: 23 }, (_, index) => ({
    id: `msg_${String(index).padStart(3, "0")}`,
    type: "user",
    time: { created: index },
    text: "Hidden synthetic content",
    files: [],
    agents: [],
    skills: [],
    metadata: {
      legalworkPrompt: {
        visibleText:
          index === 22 ? "x".repeat(14000) : `Visible message ${index}`,
        reminders: ["Hidden synthetic content"],
      },
    },
  }));
  sources.sessionMessages = async (id, limit, before) => {
    expect(id).toBe("chat");
    expect(limit).toBe(20);
    const eligible = messages.filter(
      (message) => !before || message.id < before,
    );
    const page = eligible.slice(-limit);
    return {
      sessionID: id,
      messages: page,
      nextBefore: eligible.length > limit ? page[0].id : null,
    };
  };
  const first = await readProjectContent(sources, {
    kind: "sessions",
    id: "chat",
  });
  expect(first.nextOffset).toBe(12000);
  expect(first.nextBefore).toBe("msg_003");
  const second = await readProjectContent(sources, {
    kind: "sessions",
    id: "chat",
    offset: first.nextOffset,
  });
  expect(second.nextOffset).toBeNull();
  const older = await readProjectContent(sources, {
    kind: "sessions",
    id: "chat",
    before: first.nextBefore,
  });
  expect(older.nextBefore).toBeNull();
  const transcript = [older.content, first.content + second.content].join("\n");
  const parsed = transcript.split("\n").map((line) => JSON.parse(line));
  expect(parsed).toHaveLength(23);
  expect(parsed.at(-1).text).toHaveLength(14000);
  expect(transcript).not.toMatch(
    /Hidden synthetic|Ignored content|Private reasoning|Internal tool result/,
  );
  sources.sessionMessages = async () => ({
    sessionID: "other",
    messages,
    nextBefore: null,
  });
  await expect(
    readProjectContent(sources, { kind: "sessions", id: "chat" }),
  ).rejects.toThrow("not attached");
});

test("file and task pagination cover all entries without leaking another project's tasks", async () => {
  const sources = await setup();
  for (let i = 0; i < 5; i++) {
    await writeFile(
      join(sources.workspace.path, "Notes", `Note ${i}.md`),
      `# Note ${i}`,
    );
    sources.tasks.createTask(
      { title: `Task ${i}`, projectId: sources.workspace.id },
      actor,
      i + 1,
    );
  }
  for (const kind of ["tasks", "notes"]) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await listProjectContents(sources, {
        kind,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
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
  const other = sources.tasks.createTask(
    { title: "Other", projectId: "other" },
    actor,
  );
  await expect(
    readProjectContent(sources, { kind: "tasks", id: other.id }),
  ).rejects.toThrow("not attached");
  await writeFile(join(sources.workspace.path, ".secret"), "do not read");
  await writeFile(
    join(sources.workspace.path, "..", "outside.txt"),
    "do not read",
  );
  await symlink(
    join(sources.workspace.path, "..", "outside.txt"),
    join(sources.workspace.path, "escape.txt"),
  );
  for (const id of ["../outside.txt", ".secret", "escape.txt", "/etc/passwd"]) {
    await expect(
      readProjectContent(sources, { kind: "files", id }),
    ).rejects.toThrow();
  }
  const own = sources.tasks.createTask(
    {
      title: "Own task",
      description: "Task detail",
      projectId: sources.workspace.id,
    },
    actor,
  );
  expect(
    (await readProjectContent(sources, { kind: "tasks", id: own.id })).content,
  ).toContain("Task detail");
});

test("long note and transcript reads carry continuation and reject unlinked recordings", async () => {
  const sources = await setup();
  const content = "a".repeat(13000);
  await writeFile(join(sources.workspace.path, "Notes", "Long.md"), content);
  const first = await readProjectContent(sources, {
    kind: "notes",
    id: "Notes/Long.md",
  });
  const second = await readProjectContent(sources, {
    kind: "notes",
    id: "Notes/Long.md",
    offset: first.nextOffset,
  });
  expect(first.content + second.content).toBe(content);
  expect(second.nextOffset).toBeNull();
  sources.recorder = {
    status: () => ({
      available: true,
      recordingActive: false,
      liveTranscriptActive: false,
      fileName: null,
      error: null,
    }),
    setLiveTranscript: () => ({
      available: true,
      recordingActive: false,
      liveTranscriptActive: false,
      fileName: null,
      error: null,
    }),
    listProjectRecordings: async (projectId) =>
      projectId === sources.workspace.id
        ? [
            {
              id: "linked",
              title: "Call",
              durationMs: 1200,
              segmentCount: 1,
              status: "complete",
            },
          ]
        : [],
    readProjectRecording: async (projectId, id) =>
      projectId === sources.workspace.id && id === "linked"
        ? {
            segments: [
              {
                id: "s",
                startMs: 1000,
                endMs: 1200,
                text: "Meeting text",
                final: true,
              },
            ],
          }
        : null,
  };
  expect(
    (await listProjectContents(sources, { kind: "recordings" })).sections[0]
      .items[0].title,
  ).toBe("Call");
  expect(
    (await readProjectContent(sources, { kind: "recordings", id: "linked" }))
      .content,
  ).toBe("[1s] Meeting text");
  await expect(
    readProjectContent(sources, { kind: "recordings", id: "unlinked" }),
  ).rejects.toThrow("not attached");
});

test("metadata label provenance survives a project save and reopen", async () => {
  const { workspace } = await setup();
  await updateProjectDetails(workspace.path, {
    revision: 0,
    fields: [
      {
        id: "client",
        label: "Mandant",
        labelSource: "suggested",
        type: "text",
        value: "Example",
      },
      {
        id: "own",
        label: "Mandant",
        labelSource: "custom",
        type: "text",
        value: null,
      },
    ],
  });
  const fields = (await readProjectDetails(workspace.path)).fields;
  expect(fields.map((field) => field.labelSource)).toEqual([
    "suggested",
    "custom",
  ]);
  expect(fields[0].value).toBe("Example");
});

test("native transcript exposes visible user and assistant prose while retaining pagination identity", async () => {
  const sources = await setup();
  sources.session = async (id) => ({
    id,
    title: "Fixture",
    location: { directory: sources.workspace.path },
    time: { created: 0, updated: 1 },
  });
  const nativeMessages: Awaited<
    ReturnType<ProjectContentSources["sessionMessages"]>
  >["messages"] = [
    {
      id: "user",
      type: "user",
      time: { created: 1 },
      text: "Question\nPRIVATE-REMINDER",
      files: [],
      agents: [],
      skills: [],
      metadata: {
        legalworkPrompt: {
          visibleText: "Question",
          reminders: ["PRIVATE-REMINDER"],
        },
      },
    },
    {
      id: "synthetic",
      type: "synthetic",
      time: { created: 2 },
      text: "PRIVATE-SYSTEM",
      metadata: { legalworkSystemReminder: true },
    },
    {
      id: "assistant",
      type: "assistant",
      time: { created: 3 },
      agent: "legalwork",
      model: { providerID: "fixture", id: "fixture" },
      content: [
        { type: "text", text: "Supported answer" },
        {
          type: "reasoning",
          text: "PRIVATE-REASONING",
          time: { created: 3, completed: 4 },
        },
        {
          type: "tool",
          id: "call",
          name: "read",
          time: { created: 3, ran: 3, completed: 4 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "PRIVATE-TOOL" }],
            metadata: {},
          },
        },
      ],
    },
  ];
  sources.sessionMessages = async (id) => ({
    sessionID: id,
    nextBefore: null,
    messages: nativeMessages,
  });
  const result = await readProjectContent(sources, {
    kind: "sessions",
    id: "chat",
  });
  expect(result.content).toContain("Question");
  expect(result.content).toContain("Supported answer");
  expect(result.content).not.toContain("PRIVATE-");
});
