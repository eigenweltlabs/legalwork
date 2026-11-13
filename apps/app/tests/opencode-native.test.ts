import { afterEach, expect, test } from "bun:test";
import type {
  SessionInfo,
  SessionMessageInfo,
  OpenCodeEvent,
} from "@opencode/client";
import type { UIMessage } from "ai";
import { createClient, resolveRequestTimeoutMs } from "../src/app/lib/opencode";
import {
  nativePrompt,
  sendSessionPrompt,
  systemReminderPart,
} from "../src/app/lib/system-reminder";
import {
  projectMessage,
  projectMessages,
  projectSession,
  toolDisplayText,
} from "../src/app/lib/opencode-view";
import { readMessages } from "../src/app/lib/opencode-read";
import {
  abortSession,
  revertSession,
  unrevertSession,
  forkSession,
} from "../src/app/lib/opencode-session";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  permissionKey,
  permissionWithReceivedAt,
  questionWithReceivedAt,
  replyToQuestion,
} from "../src/react-app/domains/session/sync/interaction-state";
import {
  fieldVisible,
  initialFormAnswers,
} from "../src/react-app/domains/session/modals/native-form-panel";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  getReactQueryClient().clear();
});
const tokens = {
  input: 40,
  output: 10,
  reasoning: 5,
  cache: { read: 20, write: 3 },
};
const session: SessionInfo = {
  id: "ses_native",
  projectID: "project",
  title: "Native",
  location: { directory: "/fixture" },
  cost: 0.1,
  tokens,
  time: { created: 1, updated: 2 },
};
function nativeEvent<T extends OpenCodeEvent>(event: T): T {
  return event;
}
function server(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  cleanups.push(() => server.stop(true));
  return createClient(server.url.toString().replace(/\/$/, ""));
}

test("native prompt admission preserves full context and every attachment while recording visible text", () => {
  const reminder = "Context ".repeat(30_000);
  const request = nativePrompt({
    sessionID: session.id,
    model: { providerID: "fixture", modelID: "model" },
    parts: [
      { type: "text", text: "Review this" },
      systemReminderPart(reminder),
      {
        type: "file",
        mime: "application/pdf",
        url: "file:///fixture/source.pdf",
        filename: "source.pdf",
      },
      { type: "agent", name: "reviewer" },
      { type: "skill", id: "skill-review" },
    ],
  });
  expect(request.text).toBe(
    `Review this\n\n<system-reminder>\n${reminder}\n</system-reminder>`,
  );
  expect(request.metadata.legalworkPrompt).toEqual({
    visibleText: "Review this",
    reminders: [`<system-reminder>\n${reminder}\n</system-reminder>`],
  });
  expect(request.files).toEqual([
    { uri: "file:///fixture/source.pdf", name: "source.pdf" },
  ]);
  expect(request.agents).toEqual([{ name: "reviewer" }]);
  expect(request.skills).toEqual([{ id: "skill-review" }]);
  expect(request).not.toHaveProperty("system");
  expect(request).not.toHaveProperty("model");
});

test("native transcript hides reminders, retains full tools, citations and model/token information", () => {
  const output = "full output ".repeat(20_000);
  const messages: SessionMessageInfo[] = [
    {
      id: "user",
      type: "user",
      time: { created: 1 },
      text: "Review\n\nSECRET MODEL CONTEXT",
      metadata: {
        legalworkPrompt: {
          visibleText: "Review",
          reminders: ["SECRET MODEL CONTEXT"],
        },
        legalworkScheduledTask: { taskId: "task" },
      },
      files: [
        {
          mime: "application/pdf",
          data: "",
          source: { type: "uri", uri: "file:///fixture/source.pdf" },
          name: "source.pdf",
        },
      ],
    },
    {
      id: "reminder",
      type: "synthetic",
      time: { created: 2 },
      text: "Internal",
      // Upstream v1 conversion retains native synthetic text but drops metadata.

    },
    {
      id: "assistant",
      type: "assistant",
      agent: "legalwork",
      model: { providerID: "fixture", id: "model", variant: "high" },
      time: { created: 3, completed: 4 },
      tokens,
      cost: 0.3,
      content: [
        {
          type: "reasoning",
          text: "Reasoning",
          time: { created: 3, completed: 4 },
        },
        {
          type: "tool",
          id: "tool",
          name: "office.word.read",
          time: { created: 3, ran: 3, completed: 4 },
          state: {
            status: "completed",
            input: { path: "source.pdf" },
            metadata: {},
            content: [
              { type: "text", text: output },
              {
                type: "file",
                uri: "file:///fixture/result.docx",
                mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                name: "result.docx",
              },
            ],
          },
        },
        { type: "text", text: "Done" },
      ],
    },
  ];
  const view = projectMessages(session.id, messages);
  expect(view).toHaveLength(2);
  expect(view[0].parts[0]).toMatchObject({ type: "text", text: "Review" });
  expect(view[0].parts[1]).toMatchObject({
    type: "file",
    url: "file:///fixture/source.pdf",
  });
  const ui = snapshotToUIMessages({
    session: projectSession(session),
    messages: view,
    todos: [],
    status: { type: "idle" },
  });
  expect(JSON.stringify(ui)).not.toContain("SECRET MODEL CONTEXT");
  expect(
    ui[1].parts.find((part) => part.type === "dynamic-tool"),
  ).toMatchObject({ toolCallId: "tool", output });
  expect(ui[1].parts.find((part) => part.type === "file")).toMatchObject({
    url: "file:///fixture/result.docx",
  });
  expect(view[1].info.tokens).toEqual(tokens);
  expect(view[1].native).toEqual(messages[2]);
});

test("native system notices stay out of chat without removing ordinary messages about Code Mode", () => {
  const instructions: SessionMessageInfo = {
    id: "catalog", type: "system", time: { created: 1 },
    text: "The Code Mode tool catalog has changed. Use execute to call these tools.",
    metadata: { notice: "instructions", instructionSources: ["core/codemode"] },
  };
  const original = JSON.stringify(instructions);
  expect(projectMessage(session.id, instructions)).toEqual([]);
  expect(projectMessage(session.id, { ...instructions, metadata: undefined })).toEqual([]);
  expect(JSON.stringify(instructions)).toBe(original);
  const visible = projectMessages(session.id, [
    instructions,
    { id: "question", type: "user", time: { created: 2 }, text: "What is Code Mode?" },
    { id: "reply", type: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "model" },
      time: { created: 3, completed: 4 }, content: [{ type: "text", text: "Code Mode calls tools." }] },
  ]);
  expect(visible.map(message => message.info.id)).toEqual(["question", "reply"]);
  expect(snapshotToUIMessages({ session: projectSession(session), messages: visible, todos: [], status: { type: "idle" } })
    .flatMap(message => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "What is Code Mode?" }),
      expect.objectContaining({ type: "text", text: "Code Mode calls tools." }),
    ]));
});

test("native instruction updates stay model-visible without appearing as assistant replies", () => {
  const notice: SessionMessageInfo = {
    id: "catalog-update", type: "system", time: { created: 2 },
    metadata: { notice: "instructions", instructionSources: ["core/codemode"] },
    description: "Instructions updated: core/codemode",
    text: "The Code Mode tool catalog has changed.\n\nINTERNAL TOOL CATALOG",
  };
  const messages: SessionMessageInfo[] = [
    { id: "user", type: "user", time: { created: 1 }, text: "Can you access cloud storage?" },
    notice,
    { ...notice, id: "connection", metadata: { notice: "connection" }, text: "Cloud storage connected." },
    {
      id: "assistant", type: "assistant", time: { created: 3, completed: 4 },
      agent: "legalwork", model: { providerID: "fixture", id: "model" },
      tokens, cost: 0, content: [{ type: "text", text: "I can access the test storage." }],
    },
  ];
  const original = structuredClone(messages);
  // Live message publication and snapshot reads share this native projection.
  expect(projectMessage(session.id, notice)).toEqual([]);
  const view = projectMessages(session.id, messages);
  expect(view.map(message => message.info.id)).toEqual(["user", "assistant"]);
  const ui = snapshotToUIMessages({
    session: projectSession(session), messages: view, todos: [], status: { type: "idle" },
  });
  expect(JSON.stringify(ui)).not.toContain("INTERNAL TOOL CATALOG");
  expect(JSON.stringify(ui)).not.toContain("Cloud storage connected.");
  expect(JSON.stringify(ui)).toContain("I can access the test storage.");
  expect(messages).toEqual(original);
});

test("native write transport sends native routes, archive restoration, model variant and atomic text", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = server(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push({
      path,
      body: request.method === "GET" ? undefined : await request.json(),
    });
    return path.endsWith("/prompt")
      ? Response.json({
          data: {
            id: "inbox",
            sessionID: session.id,
            type: "user",
            time: { created: 1 },
            payload: { text: "Question" },
            delivery: "queue",
          },
        })
      : new Response(null, { status: 204 });
  });
  const receipt = await sendSessionPrompt(client, {
    sessionID: session.id,
    model: { providerID: "fixture", modelID: "model" },
    variant: "high",
    agent: "legalwork",
    parts: [{ type: "text", text: "Question" }, systemReminderPart("Context")],
  });
  expect(receipt).toMatchObject({ id: "inbox", sessionID: session.id });
  expect(calls.map((call) => call.path)).toEqual([
    `/api/session/${session.id}`,
    `/api/session/${session.id}/model`,
    `/api/session/${session.id}/agent`,
    `/api/session/${session.id}/prompt`,
  ]);
  expect(calls[0].body).toEqual({ archived: false });
  expect(calls[1].body).toEqual({
    model: { providerID: "fixture", id: "model", variant: "high" },
  });
  expect(calls[3].body).toMatchObject({
    text: "Question\n\n<system-reminder>\nContext\n</system-reminder>",
    metadata: { legalworkPrompt: { visibleText: "Question" } },
  });
});

test("history pagination retrieves every native page without a new content limit", async () => {
  const cursors: Array<string | null> = [];
  const client = server((request) => {
    const url = new URL(request.url);
    cursors.push(url.searchParams.get("cursor"));
    if(url.searchParams.has("cursor"))expect(url.searchParams.has("order")).toBe(false);
    else expect(url.searchParams.get("order")).toBe("asc");
    return Response.json({
      data: [
        {
          id: cursors.length === 1 ? "first" : "last",
          type: "user",
          time: { created: cursors.length },
          text: "complete",
        },
      ],
      cursor: { next: cursors.length === 1 ? "page-two" : null },
    });
  });
  expect(
    (await readMessages(client, session.id)).map((message) => message.info.id),
  ).toEqual(["first", "last"]);
  expect(cursors).toEqual([null, "page-two"]);
});

test("native live deltas and tool lifecycle retain full output without per-token HTTP requests", () => {
  const input = {
    workspaceId: "native",
    baseUrl: "http://127.0.0.1:1",
    legalworkToken: "fixture",
  };
  cleanups.push(__createWorkspaceSessionSyncForTest(input));
  cleanups.push(trackWorkspaceSessionSync(input, session.id));
  const emit = (event: OpenCodeEvent) =>
    __applySessionSyncEventForTest(input, event);
  const common = {
    id: "event",
    created: 3,
    location: { directory: "/fixture" },
    durable: { aggregateID: session.id, seq: 1, version: 1 as const },
  };
  emit(
    nativeEvent({
      ...common,
      type: "session.step.started",
      data: {
        sessionID: session.id,
        assistantMessageID: "assistant",
        agent: "legalwork",
        model: { providerID: "fixture", id: "model" },
        started: 3,
      },
    }),
  );
  emit(
    nativeEvent({
      ...common,
      type: "session.reasoning.started",
      data: {
        sessionID: session.id,
        assistantMessageID: "assistant",
        ordinal: 0,
      },
    }),
  );
  emit(
    nativeEvent({
      ...common,
      type: "session.reasoning.ended",
      data: {
        sessionID: session.id,
        assistantMessageID: "assistant",
        ordinal: 0,
        text: "Think",
      },
    }),
  );
  emit(
    nativeEvent({
      ...common,
      type: "session.tool.input.started",
      data: {
        sessionID: session.id,
        assistantMessageID: "assistant",
        id: "tool",
        name: "read",
      },
    }),
  );
  emit(
    nativeEvent({
      ...common,
      type: "session.tool.called",
      data: {
        sessionID: session.id,
        assistantMessageID: "assistant",
        id: "tool",
        input: { path: "file" },
        executed: true,
      },
    }),
  );
  const output = "large ".repeat(20_000);
  emit(
    nativeEvent({
      ...common,
      durable: { ...common.durable, version: 2 },
      type: "session.tool.success",
      data: {
        sessionID: session.id,
        assistantMessageID: "assistant",
        id: "tool",
        content: [{ type: "text", text: output }],
        executed: true,
      },
    }),
  );
  const ui =
    getReactQueryClient().getQueryData<UIMessage[]>(
      transcriptKey(input.workspaceId, session.id),
    ) ?? [];
  expect(ui[0].parts.find((part) => part.type === "reasoning")).toMatchObject({
    text: "Think",
  });
  expect(
    ui[0].parts.find((part) => part.type === "dynamic-tool"),
  ).toMatchObject({ output });
});

test("native permission projection keeps exact source and source-session ownership", () => {
  const pending = permissionWithReceivedAt(
    {
      id: "permission",
      sessionID: "child",
      action: "file.read",
      resources: ["/outside"],
      source: { type: "tool", messageID: "message", id: "tool" },
      save: ["/outside/*"],
    },
    1,
  );
  expect(pending).toMatchObject({
    sessionID: "child",
    tool: { messageID: "message", callID: "tool" },
    v2: { action: "file.read", resources: ["/outside"], save: ["/outside/*"] },
  });
});

test("native forms preserve option values and conditional numeric/boolean answers", async () => {
  const form = {
    id: "form",
    sessionID: session.id,
    title: "Review options",
    fields: [
      { key: "approve", type: "boolean" as const, default: false },
      {
        key: "count",
        type: "integer" as const,
        when: [{ key: "approve", op: "eq" as const, value: true }],
      },
      {
        key: "choice",
        type: "string" as const,
        options: [{ value: "safe", label: "Safe option" }],
      },
    ],
  } satisfies Parameters<typeof questionWithReceivedAt>[0];
  expect(fieldVisible(form.fields[1], form, initialFormAnswers(form))).toBe(
    false,
  );
  expect(fieldVisible(form.fields[1], form, [["true"], ["3"], ["safe"]])).toBe(
    true,
  );
  let body: unknown;
  const client = server(async (request) => {
    body = await request.json();
    return new Response(null, { status: 204 });
  });
  await replyToQuestion(
    client,
    questionWithReceivedAt(form, 1),
    [["true"], ["3"], ["safe"]],
    "/fixture",
  );
  expect(body).toEqual({ answer: { approve: true, count: 3, choice: "safe" } });
});

test("native long operations and event streams have no transport task deadline", () => {
  for (const action of [
    "prompt",
    "synthetic",
    "shell",
    "command",
    "compact",
    "wait",
  ])
    expect(
      resolveRequestTimeoutMs(
        new Request(`http://127.0.0.1/api/session/id/${action}`, {
          method: "POST",
        }),
        10_000,
      ),
    ).toBe(0);
});

test("tool reminders remain model-visible native content without corrupting rich JSON cards", () => {
  const reminder =
    '<system-reminder topic="sidebar">\nDoc open\n</system-reminder>';
  const card = JSON.stringify({ kind: "review", id: "artifact" });
  const content = [
    { type: "text", text: reminder },
    { type: "text", text: card },
  ];
  expect(
    toolDisplayText(content, {
      legalworkSystemReminders: { sidebar: "Doc open" },
    }),
  ).toBe(card);
  expect(content[0].text).toBe(reminder);
  expect(toolDisplayText([{ type: "text", text: reminder }], {})).toBe(
    reminder,
  );
});
