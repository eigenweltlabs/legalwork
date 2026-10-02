import { describe, expect, test } from "bun:test";

import { appStateReminders } from "./app-state-reminders.js";

function userMessage() {
  const message: { message: { id: string }; parts: object[] } = { message: { id: "msg_1" }, parts: [] };
  return message;
}

describe("app state reminders", () => {
  test("report a change once, on the user message, as a hidden part the engine can save", async () => {
    let state = "Vertrag.docx is open";
    const reminders = appStateReminders(async () => state, "Nothing is open any more.");

    const first = userMessage();
    await reminders.userMessage({ sessionID: "ses_1" }, first);
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0]).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      synthetic: true,
      text: "<system-reminder>\nVertrag.docx is open\n</system-reminder>",
    });
    expect(String(Reflect.get(first.parts[0], "id"))).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

    const second = userMessage();
    await reminders.userMessage({ sessionID: "ses_1" }, second);
    expect(second.parts).toEqual([]);

    state = "";
    const cleared = userMessage();
    await reminders.userMessage({ sessionID: "ses_1" }, cleared);
    expect(Reflect.get(cleared.parts[0], "text")).toContain("Nothing is open any more.");
  });

  test("append a change during a run to the next text tool result only", async () => {
    let state = "";
    const reminders = appStateReminders(async () => state, "cleared");
    state = "Anlage 1.docx is open";

    const mcp: { content: unknown[]; output?: unknown } = { content: [{ type: "text", text: "result" }] };
    await reminders.toolResult({ sessionID: "ses_1" }, mcp);
    expect(mcp).toEqual({ content: [{ type: "text", text: "result" }] });

    const result = { output: "done" };
    await reminders.toolResult({ sessionID: "ses_1" }, result);
    expect(result.output).toBe("done\n\n<system-reminder>\nAnlage 1.docx is open\n</system-reminder>");
  });

  test("treat an unreadable state as no change and report again after a compaction", async () => {
    let state: string | null = "Word pane connected";
    const reminders = appStateReminders(async () => state, "cleared");
    await reminders.userMessage({ sessionID: "ses_1" }, userMessage());

    state = null;
    const failed = { output: "x" };
    await reminders.toolResult({ sessionID: "ses_1" }, failed);
    expect(failed.output).toBe("x");

    state = "Word pane connected";
    reminders.event({ event: { type: "session.compacted", properties: { sessionID: "ses_other" } } });
    const unchanged = { output: "y" };
    await reminders.toolResult({ sessionID: "ses_1" }, unchanged);
    expect(unchanged.output).toBe("y");

    reminders.event({ event: { type: "session.compacted", properties: { sessionID: "ses_1" } } });
    const restated = { output: "z" };
    await reminders.toolResult({ sessionID: "ses_1" }, restated);
    expect(restated.output).toContain("Word pane connected");
  });
});
