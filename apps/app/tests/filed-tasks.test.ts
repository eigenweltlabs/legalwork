import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { filedTasksOf } from "../src/components/chat/filed-tasks";

type Parts = UIMessage["parts"];

const created = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "dynamic-tool",
    toolName: "legalwork_task_create",
    toolCallId: `call-${id}`,
    state: "output-available",
    input: { title },
    output: JSON.stringify({ ok: true, message: "Filed.", task: { id, title, ...extra } }),
  }) as unknown as Parts[number];

describe("filedTasksOf", () => {
  test("reads the tasks a message filed off the create tool's results, each once", () => {
    const parts: Parts = [
      { type: "text", text: "Ich lege die Aufgabe an." },
      created("t1", "Vollmacht einholen"),
      created("t1", "Vollmacht einholen"),
      created("t2", "  "),
      { type: "text", text: "Erledigt." },
    ];
    expect(filedTasksOf(parts)).toEqual([
      { id: "t1", title: "Vollmacht einholen" },
      { id: "t2", title: null },
    ]);
  });

  test("keeps a task the prose also links — the strip lists it like a mentioned file", () => {
    const parts: Parts = [
      created("t1", "Vollmacht einholen"),
      { type: "text", text: "Angelegt: [Vollmacht einholen](legalworktask://t1)." },
    ];
    expect(filedTasksOf(parts)).toEqual([{ id: "t1", title: "Vollmacht einholen" }]);
  });

  test("ignores other tools, failed calls and unreadable output", () => {
    const parts: Parts = [
      { ...(created("t1", "x") as object), toolName: "legalwork_task_update" } as unknown as Parts[number],
      { ...(created("t2", "x") as object), state: "output-error", output: undefined } as unknown as Parts[number],
      { ...(created("t3", "x") as object), output: "not json" } as unknown as Parts[number],
      { ...(created("t4", "x") as object), output: JSON.stringify({ ok: false, error: "nope" }) } as unknown as Parts[number],
      { type: "tool-legalwork_task_create", toolCallId: "c5", state: "output-available", input: {}, output: { ok: true, task: { id: "t5", title: "Objekt statt Text" } } } as unknown as Parts[number],
    ];
    expect(filedTasksOf(parts)).toEqual([{ id: "t5", title: "Objekt statt Text" }]);
  });
});
