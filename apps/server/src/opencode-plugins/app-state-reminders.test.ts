import { describe, expect, test } from "bun:test";

import { appStateReminders, systemReminder } from "./app-state-reminders.js";

function userMessage() {
  const message: { message: { id: string }; parts: object[] } = { message: { id: "msg_1" }, parts: [] };
  return message;
}

type Saved = { parts: { type: string; text?: string; state?: { status: string; output?: string } }[] }[];

/** An engine client whose saved conversation is `saved`; counts the lookups. */
function savedConversation(saved: Saved | Error) {
  const calls: string[] = [];
  const client = {
    session: {
      async messages(options: { path: { id: string } }) {
        calls.push(options.path.id);
        if (saved instanceof Error) throw saved;
        return { data: saved };
      },
    },
  };
  return { calls, client };
}

describe("app state reminders", () => {
  test("report a change once, on the user message, as a hidden part the engine can save", async () => {
    let state = "Vertrag.docx is open";
    const reminders = appStateReminders("sidebar", async () => state, "Nothing is open any more.");

    const first = userMessage();
    await reminders.userMessage({ sessionID: "ses_1" }, first);
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0]).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      synthetic: true,
      text: '<system-reminder topic="sidebar">\nVertrag.docx is open\n</system-reminder>',
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

  test("append a change during a run to the next tool result, first in connector content", async () => {
    let state = "";
    const reminders = appStateReminders("sidebar", async () => state, "cleared");
    state = "Anlage 1.docx is open";

    const unsupported: { output?: unknown } = { output: { structured: true } };
    await reminders.toolResult({ sessionID: "ses_1" }, unsupported);
    expect(unsupported).toEqual({ output: { structured: true } });

    // The engine joins connector content and shortens it from the end afterwards.
    const mcp = { content: [{ type: "text", text: "result" }] };
    await reminders.toolResult({ sessionID: "ses_1" }, mcp);
    expect(mcp.content).toEqual([
      { type: "text", text: systemReminder("sidebar", "Anlage 1.docx is open") },
      { type: "text", text: "result" },
    ]);

    state = "Anlage 2.docx is open";
    const result = { output: "done" };
    await reminders.toolResult({ sessionID: "ses_1" }, result);
    expect(result.output).toBe('done\n\n<system-reminder topic="sidebar">\nAnlage 2.docx is open\n</system-reminder>');
  });

  test("treat an unreadable state as no change and report again after a compaction", async () => {
    let state: string | null = "Word pane connected";
    const reminders = appStateReminders("word-pane", async () => state, "cleared");
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

  test("after a restart, continue from the latest reminder saved in the conversation", async () => {
    const { calls, client } = savedConversation([
      { parts: [{ type: "text", text: "Prüfe den Vertrag" }, { type: "text", text: systemReminder("sidebar", "Vertrag.docx is open") }] },
      { parts: [{ type: "tool", state: { status: "completed", output: `read\n\n${systemReminder("sidebar", "Anlage.docx is open")}` } }] },
      { parts: [{ type: "text", text: systemReminder("word-pane", "Word pane connected") }] },
    ]);

    let state = "Anlage.docx is open";
    const reminders = appStateReminders("sidebar", async () => state, "Nothing is open any more.", { client });
    const unchanged = userMessage();
    await reminders.userMessage({ sessionID: "ses_1" }, unchanged);
    expect(unchanged.parts).toEqual([]);

    // The file was closed while the engine was down: the saved reminder no longer holds.
    const closedBeforeRestart = appStateReminders("sidebar", async () => "", "Nothing is open any more.", { client });
    const cleared = userMessage();
    await closedBeforeRestart.userMessage({ sessionID: "ses_1" }, cleared);
    expect(Reflect.get(cleared.parts[0], "text")).toBe(systemReminder("sidebar", "Nothing is open any more."));

    // The saved conversation is read once per session.
    state = "";
    await reminders.userMessage({ sessionID: "ses_1" }, userMessage());
    expect(calls).toEqual(["ses_1", "ses_1"]);
  });

  test("ignore saved reminders from before the last compaction, and a saved cleared reminder", async () => {
    const compacted = savedConversation([
      { parts: [{ type: "text", text: systemReminder("sidebar", "Vertrag.docx is open") }] },
      { parts: [{ type: "compaction" }] },
      { parts: [{ type: "text", text: "Summary of the conversation so far" }] },
    ]);
    const afterCompaction = appStateReminders("sidebar", async () => "Vertrag.docx is open", "cleared", { client: compacted.client });
    const restated = userMessage();
    await afterCompaction.userMessage({ sessionID: "ses_1" }, restated);
    expect(Reflect.get(restated.parts[0], "text")).toBe(systemReminder("sidebar", "Vertrag.docx is open"));

    const closed = savedConversation([{ parts: [{ type: "text", text: systemReminder("sidebar", "cleared") }] }]);
    const stillClosed = appStateReminders("sidebar", async () => "", "cleared", { client: closed.client });
    const nothing = userMessage();
    await stillClosed.userMessage({ sessionID: "ses_1" }, nothing);
    expect(nothing.parts).toEqual([]);
  });

  test("report a change once across parallel tool results, and without history when it is unreadable", async () => {
    const { calls, client } = savedConversation([]);
    const reminders = appStateReminders("project", async () => "Revision 4", "cleared", { client });
    const results = [{ output: "a" }, { output: "b" }];
    await Promise.all(results.map((result) => reminders.toolResult({ sessionID: "ses_1" }, result)));
    expect(results.filter((result) => result.output.includes("Revision 4"))).toHaveLength(1);
    expect(calls).toEqual(["ses_1"]);

    const unreadable = appStateReminders("project", async () => "Revision 4", "cleared", savedConversation(new Error("engine busy")));
    const result = { output: "c" };
    await unreadable.toolResult({ sessionID: "ses_1" }, result);
    expect(result.output).toContain("Revision 4");
  });
});
