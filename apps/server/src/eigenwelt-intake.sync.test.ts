import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  intakeDeleteAttachment,
  intakeDeleteTask,
  intakePullTasks,
  intakeRestoreTask,
  intakeUploadAttachment,
  parseIntakeTask,
  type IntakeClient,
} from "./eigenwelt-intake.js";

/** The platform calls the task sync makes (task-sync.ts), on the wire. */

const client: IntakeClient = { platformURL: "https://platform.test", platformToken: "tok_secret" };

type Call = { url: string; method: string; body: unknown };
const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let answer: unknown = {};

beforeEach(() => {
  calls = [];
  answer = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ?? null });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TASK = {
  id: "11111111-1111-4111-8111-111111111111",
  origin: "desktop",
  endpointId: null,
  endpointName: null,
  title: "Vollmacht",
  status: "open",
  priority: 2,
  createdByUserId: "user_ada",
  attachments: [],
  createdAt: "2026-09-16T08:00:00.000Z",
  updatedAt: "2026-09-16T09:00:00.000Z",
  deletedAt: null,
};

describe("parseIntakeTask, for a task filed from LegalWork", () => {
  test("keeps the origin, the creator and the trash marker; an endpoint-less task is a desktop one", () => {
    const task = parseIntakeTask({ ...TASK, deletedAt: "2026-09-16T10:00:00.000Z" });
    expect(task).toMatchObject({
      origin: "desktop",
      endpointId: null,
      endpointName: null,
      createdByUserId: "user_ada",
      deletedAt: "2026-09-16T10:00:00.000Z",
    });
    // An older platform that sends no origin: the endpoint decides.
    expect(parseIntakeTask({ ...TASK, origin: undefined, endpointId: "ep-1" })?.origin).toBe("intake");
    expect(parseIntakeTask({ ...TASK, origin: undefined })?.origin).toBe("desktop");
  });
});

describe("intakePullTasks", () => {
  test("asks for the delta with its extras and reads notes, submission and the hidden ids", async () => {
    answer = {
      tasks: [
        {
          ...TASK,
          notes: [{ id: "n1", body: "Gelesen.", source: "agent", authorUserId: "user_bob", createdAt: "2026-09-16T08:30:00.000Z" }],
          submission: { rawPayload: { subject: "WG: Frist" } },
        },
        { id: "" },
      ],
      nextCursor: "page-2",
      hidden: ["22222222-2222-4222-8222-222222222222", 7],
    };
    const page = await intakePullTasks(client, {
      updatedSince: "2026-09-16T00:00:00.000Z",
      deleted: "include",
      include: ["notes", "submission"],
      sort: "updated",
      order: "asc",
      limit: 100,
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/intake/tasks");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      updatedSince: "2026-09-16T00:00:00.000Z",
      deleted: "include",
      include: "notes,submission",
      sort: "updated",
      order: "asc",
      limit: "100",
    });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]!.notes).toEqual([
      expect.objectContaining({ id: "n1", body: "Gelesen.", source: "agent", authorUserId: "user_bob" }),
    ]);
    expect(page.tasks[0]!.submission).toEqual({ rawPayload: { subject: "WG: Frist" } });
    expect(page.nextCursor).toBe("page-2");
    expect(page.hidden).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  test("a page without extras has empty notes, no submission and no hidden ids", async () => {
    answer = { tasks: [TASK], nextCursor: null };
    const page = await intakePullTasks(client, {});
    expect(page.tasks[0]).toMatchObject({ notes: [], submission: null });
    expect(page.hidden).toEqual([]);
  });
});

describe("trash and attachments", () => {
  test("deletes and restores by id", async () => {
    answer = { task: TASK };
    expect((await intakeDeleteTask(client, TASK.id))?.id).toBe(TASK.id);
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `https://platform.test/api/intake/tasks/${TASK.id}` });
    expect((await intakeRestoreTask(client, TASK.id))?.id).toBe(TASK.id);
    expect(calls[1]).toMatchObject({ method: "POST", url: `https://platform.test/api/intake/tasks/${TASK.id}/restore` });
  });

  test("uploads one file under the client's id and reads the attachment back", async () => {
    answer = { attachments: [{ id: "33333333-3333-4333-8333-333333333333", filename: "Entwurf.txt", contentType: "text/plain", size: 9 }] };
    const stored = await intakeUploadAttachment(client, TASK.id, {
      id: "33333333-3333-4333-8333-333333333333",
      filename: "Entwurf.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("Vollmacht"),
    });
    expect(stored).toEqual({ id: "33333333-3333-4333-8333-333333333333", filename: "Entwurf.txt", contentType: "text/plain", size: 9 });
    const form = calls[0]!.body as FormData;
    expect(form.get("id")).toBe("33333333-3333-4333-8333-333333333333");
    const file = form.get("files[]");
    if (!(file instanceof File)) throw new Error("files[] did not carry a File");
    expect(file.name).toBe("Entwurf.txt");
    expect(await file.text()).toBe("Vollmacht");
  });

  test("refuses a file over the relay's cap before any request", async () => {
    await expect(
      intakeUploadAttachment(client, TASK.id, {
        id: "33333333-3333-4333-8333-333333333333",
        filename: "big.bin",
        contentType: "application/octet-stream",
        bytes: new Uint8Array(25 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ status: 413, code: "intake_too_large" });
    expect(calls).toHaveLength(0);
  });

  test("removes an attachment", async () => {
    answer = { ok: true };
    await intakeDeleteAttachment(client, TASK.id, "33333333-3333-4333-8333-333333333333");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `https://platform.test/api/intake/tasks/${TASK.id}/attachments/33333333-3333-4333-8333-333333333333`,
    });
  });
});
