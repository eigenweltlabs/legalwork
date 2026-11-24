import { expect, test } from "bun:test";
import type { SessionMessageInfo } from "@opencode/client";
import { witnessedReplies } from "./chat-activity.js";

test("only visible reply text from witnessed turns enters the day log", () => {
  const user = (id: string, at: number): SessionMessageInfo => ({ type: "user", text: "Request", id, time: { created: at } });
  const reply = (id: string, at: number): SessionMessageInfo => ({ type: "assistant", id, agent: "assistant", model: { id: "fixture", providerID: "test" },
    time: { created: at, completed: at + 2 }, content: [{ type: "reasoning", text: "Internal reasoning" }, { type: "text", text: id }] });
  const records = [user("mine", 10), reply("Answer to my request", 15), user("other", 20), reply("Other turn", 24),
    reply("Observed automation", 32), reply("Tomorrow", 49)];
  const witnesses = [{ kind: "chat-request", projectId: "a", messageId: "mine", start: 10, end: 10 },
    { kind: "agent", projectId: "a", start: 31, end: 35 }];
  expect(witnessedReplies(records, witnesses, 0, 50).map(r => r.text)).toEqual(["Answer to my request", "Observed automation"]);
});

test("a fast native execution fills only unsampled time and retains unknown focus across an observation gap", async () => {
  const { unwitnessedRunSpans } = await import("./chat-activity.js");
  const base = { sessionId: "chat", projectId: "project", kind: "foreground" };
  const chat = { ...base, watching: true, start: 10, end: 20 };
  const agent = { ...base, kind: "agent", start: 15, end: 18 };
  const doc = { ...base, sessionId: undefined, start: 20, end: 25 };
  expect(unwitnessedRunSpans(12, 30, [chat, agent], [chat, agent, doc])).toEqual([
    { from: 12, to: 15, visibility: "foreground" }, { from: 18, to: 20, visibility: "foreground" },
    { from: 20, to: 25, visibility: "background" }, { from: 25, to: 30, visibility: undefined },
  ]);
});
