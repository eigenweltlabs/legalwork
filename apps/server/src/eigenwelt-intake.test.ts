import { describe, expect, test, afterEach } from "bun:test";

import {
  intakeCreateTask,
  intakeDownloadAttachment,
  intakeGetTask,
  intakeListMembers,
  intakeListTasks,
  intakePatchTask,
  intakeUploadAttachments,
  requireIntakeClient,
  EIGENWELT_INTAKE_MAX_UPLOAD_FILES,
  type IntakeClient,
} from "./eigenwelt-intake.js";
import { ApiError } from "./errors.js";

const client: IntakeClient = { platformURL: "https://platform.test", platformToken: "tok_secret" };

type FetchCall = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;
const originalPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const calls: FetchCall[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
  if (originalPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = originalPlatformUrl;
});

/**
 * Record every request and answer with one canned response. `preconnect` is
 * carried over so the stub still satisfies the runtime's fetch type.
 */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return respond(call);
    },
    { preconnect: originalFetch.preconnect },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function headerOf(call: FetchCall, name: string): string | undefined {
  const headers = call.init.headers;
  if (!headers || Array.isArray(headers) || headers instanceof Headers) return undefined;
  return headers[name];
}

const TASK = {
  id: "task_1",
  endpointId: "ep_1",
  endpointName: "Intake",
  submissionId: "sub_1",
  title: "Review NDA",
  description: "Counterparty sent an NDA",
  status: "in_progress",
  priority: 2,
  dueDate: "2026-09-30T00:00:00.000Z",
  assigneeUserId: "user_1",
  assigneeName: "Ada",
  assignmentNote: null,
  workflowHubItemId: null,
  workflowVersion: null,
  cloudRunId: null,
  lastLocalRunAt: null,
  attachments: [{ id: "att_1", filename: "nda.pdf", contentType: "application/pdf", size: 1024 }],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

describe("requireIntakeClient", () => {
  test("returns a client for an entitled connection and pins the configured platform", () => {
    process.env.EIGENWELT_PLATFORM_URL = "https://platform.test";
    expect(
      requireIntakeClient({
        // A stored (display-only) URL never becomes the fetch destination.
        platformURL: "https://evil.example",
        platformToken: "tok_secret",
      }),
    ).toEqual({ platformURL: "https://platform.test", platformToken: "tok_secret" });
  });

  test("does not gate on the plan: a signed-in firm without intake still syncs its own tasks", () => {
    // The stored entitlements block is not even consulted — the platform decides.
    expect(requireIntakeClient({ platformURL: null, platformToken: "tok_secret" }).platformToken).toBe("tok_secret");
  });

  test("refuses when no platform token is stored", () => {
    try {
      requireIntakeClient({ platformURL: null, platformToken: null });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: "intake_not_connected" });
    }
  });
});

describe("intakeListTasks", () => {
  test("shapes the filter/sort/paging query and carries the bearer token", async () => {
    stubFetch(() => jsonResponse({ tasks: [TASK], nextCursor: "cur_2" }));
    const page = await intakeListTasks(client, {
      assignee: "user_1",
      status: "open",
      endpointId: "ep_1",
      sort: "priority",
      order: "asc",
      limit: 25,
      cursor: "cur_1",
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://platform.test/api/intake/tasks");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      assignee: "user_1",
      status: "open",
      endpointId: "ep_1",
      sort: "priority",
      order: "asc",
      limit: "25",
      cursor: "cur_1",
    });
    expect(calls[0].init.method).toBe("GET");
    expect(headerOf(calls[0], "Authorization")).toBe("Bearer tok_secret");
    expect(calls[0].init.body).toBeUndefined();

    expect(page.nextCursor).toBe("cur_2");
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({ id: "task_1", status: "in_progress", priority: 2 });
    expect(page.tasks[0].attachments[0]).toEqual({
      id: "att_1",
      filename: "nda.pdf",
      contentType: "application/pdf",
      size: 1024,
    });
  });

  test("omits absent params and normalizes a page with no cursor", async () => {
    stubFetch(() => jsonResponse({ tasks: [] }));
    const page = await intakeListTasks(client);
    expect(calls[0].url).toBe("https://platform.test/api/intake/tasks");
    expect(page).toEqual({ tasks: [], nextCursor: null });
  });

  test("drops tasks the platform returned without an id", async () => {
    stubFetch(() => jsonResponse({ tasks: [TASK, { title: "no id" }, null], nextCursor: null }));
    const page = await intakeListTasks(client);
    expect(page.tasks.map((task) => task.id)).toEqual(["task_1"]);
  });
});

describe("platform answers that are not intake answers", () => {
  test("refuses a redirect instead of following it to the sign-in page", async () => {
    stubFetch(() => new Response(null, { status: 307, headers: { Location: "/sign-in" } }));
    await expect(intakeListTasks(client)).rejects.toMatchObject({
      status: 502,
      code: "intake_redirected",
    });
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("fails on a non-JSON body instead of reading it as an empty list", async () => {
    stubFetch(
      () =>
        new Response("<!doctype html><title>Sign in</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    await expect(intakeListTasks(client)).rejects.toMatchObject({
      status: 502,
      code: "intake_bad_response",
    });
  });
});

describe("intakeGetTask", () => {
  test("requests one task and relays the submission untouched", async () => {
    stubFetch(() => jsonResponse({ task: TASK, submission: { rawPayload: "…" } }));
    const detail = await intakeGetTask(client, "task 1/2");
    // The id is encoded, so a task id can never inject a path segment.
    expect(calls[0].url).toBe("https://platform.test/api/intake/tasks/task%201%2F2");
    expect(detail.task.id).toBe("task_1");
    expect(detail.submission).toEqual({ rawPayload: "…" });
    expect(detail.notes).toEqual([]);
  });

  test("relays the task's history, dropping entries it cannot show", async () => {
    stubFetch(() =>
      jsonResponse({
        task: TASK,
        submission: null,
        notes: [
          { id: "n1", body: "Prüfvermerk erstellt.", source: "agent", authorUserId: "u1", authorName: "Ada", authorEmail: "ada@kanzlei.de", createdAt: "2026-09-15T09:20:42.000Z" },
          { id: "n2", body: "", source: "member", authorUserId: "u2" },
          { body: "no id" },
          { id: "n3", body: "Gegengelesen.", source: "robot", authorUserId: "u2", createdAt: "2026-09-15T10:00:00.000Z" },
        ],
      }),
    );
    const detail = await intakeGetTask(client, "task_1");
    expect(detail.notes).toEqual([
      { id: "n1", body: "Prüfvermerk erstellt.", source: "agent", authorUserId: "u1", authorName: "Ada", authorEmail: "ada@kanzlei.de", createdAt: "2026-09-15T09:20:42.000Z" },
      // An unknown source is shown as a member's, never promoted to an agent's.
      { id: "n3", body: "Gegengelesen.", source: "member", authorUserId: "u2", authorName: null, authorEmail: null, createdAt: "2026-09-15T10:00:00.000Z" },
    ]);
  });

  test("fails loudly when the platform returns no usable task", async () => {
    stubFetch(() => jsonResponse({ task: { title: "no id" } }));
    await expect(intakeGetTask(client, "task_1")).rejects.toMatchObject({
      status: 502,
      code: "intake_request_failed",
    });
  });
});

describe("intakePatchTask", () => {
  test("sends only the fields the caller set, as JSON", async () => {
    stubFetch(() => jsonResponse({ ...TASK, status: "done" }));
    const task = await intakePatchTask(client, "task_1", { status: "done", assigneeUserId: null });

    expect(calls[0].url).toBe("https://platform.test/api/intake/tasks/task_1");
    expect(calls[0].init.method).toBe("PATCH");
    expect(headerOf(calls[0], "Content-Type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: "done", assigneeUserId: null });
    expect(task?.status).toBe("done");
  });

  test("accepts a `{ task }` envelope and answers null when neither shape comes back", async () => {
    stubFetch(() => jsonResponse({ task: TASK }));
    expect((await intakePatchTask(client, "task_1", { priority: 4 }))?.id).toBe("task_1");
    stubFetch(() => jsonResponse({ ok: true }));
    expect(await intakePatchTask(client, "task_1", { priority: 4 })).toBeNull();
  });
});

describe("intakeCreateTask", () => {
  test("posts the create body", async () => {
    stubFetch(() => jsonResponse(TASK));
    const task = await intakeCreateTask(client, { endpointId: "ep_1", title: "New", description: "d" });
    expect(calls[0].url).toBe("https://platform.test/api/intake/tasks");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      endpointId: "ep_1",
      title: "New",
      description: "d",
    });
    expect(task?.id).toBe("task_1");
  });
});

describe("intake attachments", () => {
  test("uploads as multipart files[] without a hand-set content type", async () => {
    stubFetch(() => jsonResponse({ task: TASK }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    await intakeUploadAttachments(client, "task_1", [file]);

    expect(calls[0].url).toBe("https://platform.test/api/intake/tasks/task_1/attachments");
    expect(calls[0].init.method).toBe("POST");
    // fetch must own the multipart boundary, so no Content-Type is set here.
    expect(headerOf(calls[0], "Content-Type")).toBeUndefined();
    const body = calls[0].init.body;
    expect(body).toBeInstanceOf(FormData);
    if (body instanceof FormData) {
      expect(body.getAll("files[]")).toHaveLength(1);
      expect(body.getAll("files")).toHaveLength(0);
    }
  });

  test("refuses an empty or oversized upload before any request", async () => {
    stubFetch(() => jsonResponse({}));
    await expect(intakeUploadAttachments(client, "task_1", [])).rejects.toMatchObject({ status: 400 });
    const many = Array.from(
      { length: EIGENWELT_INTAKE_MAX_UPLOAD_FILES + 1 },
      (_, index) => new File(["x"], `f${index}.txt`),
    );
    await expect(intakeUploadAttachments(client, "task_1", many)).rejects.toMatchObject({
      status: 413,
      code: "intake_too_large",
    });
    expect(calls).toHaveLength(0);
  });

  test("downloads bytes with the platform's own name and type", async () => {
    stubFetch(() =>
      new Response("PDF", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="nda review.pdf"',
        },
      }),
    );
    const attachment = await intakeDownloadAttachment(client, "task_1", "att_1");
    expect(calls[0].url).toBe("https://platform.test/api/intake/tasks/task_1/attachments/att_1");
    expect(new TextDecoder().decode(attachment.bytes)).toBe("PDF");
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.filename).toBe("nda review.pdf");
  });
});

describe("intakeListMembers", () => {
  test("reads the bare array and skips members without a user id", async () => {
    stubFetch(() =>
      jsonResponse([
        { userId: "user_1", name: "Ada", email: "ada@example.com", role: "org:admin" },
        { name: "nobody" },
      ]),
    );
    const members = await intakeListMembers(client);
    expect(calls[0].url).toBe("https://platform.test/api/intake/members");
    expect(members).toEqual([
      { userId: "user_1", name: "Ada", email: "ada@example.com", role: "org:admin" },
    ]);
  });
});

describe("error mapping", () => {
  test("maps the platform's 403 not_entitled onto intake_not_entitled", async () => {
    stubFetch(() =>
      jsonResponse({ code: "not_entitled", message: "Your plan does not include Intake." }, 403),
    );
    await expect(intakeListTasks(client)).rejects.toMatchObject({
      status: 403,
      code: "intake_not_entitled",
      message: "Your plan does not include Intake.",
    });
  });

  test("keeps a plain 403 distinct from the plan gate", async () => {
    stubFetch(() => jsonResponse({ code: "forbidden", message: "Not your task." }, 403));
    await expect(intakeGetTask(client, "task_1")).rejects.toMatchObject({
      status: 403,
      code: "intake_forbidden",
    });
  });

  test("maps the contract's status codes", async () => {
    const cases: Array<[number, string, string]> = [
      [400, "invalid_request", "intake_invalid_request"],
      [401, "unauthorized", "intake_unauthorized"],
      [404, "not_found", "intake_not_found"],
      [409, "duplicate", "intake_conflict"],
      [413, "too_large", "intake_too_large"],
      [429, "rate_limited", "intake_rate_limited"],
    ];
    for (const [status, platformCode, expected] of cases) {
      stubFetch(() => jsonResponse({ code: platformCode, message: "nope" }, status));
      await expect(intakeListTasks(client)).rejects.toMatchObject({ status, code: expected });
    }
  });

  test("turns an unexpected status or a non-JSON body into a 502", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 500 }));
    await expect(intakeListTasks(client)).rejects.toMatchObject({
      status: 502,
      code: "intake_request_failed",
      message: "<html>gateway</html>",
    });
  });

  test("turns a transport failure into intake_unreachable", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(intakeListTasks(client)).rejects.toMatchObject({
      status: 502,
      code: "intake_unreachable",
    });
  });
});

