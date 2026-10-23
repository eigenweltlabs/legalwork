import { expect, test } from "bun:test";
import { assistantReactionTarget } from "./assistant-chat.js";

const user = { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "Thanks, that helps" }] };
const reply = { info: { id: "reply", role: "assistant", parentID: "user" }, parts: [{ type: "tool", tool: "legalwork_assistant_react" }] };
test("reactions target the current human message only as the first action", () => {
  const old = { ...reply, info: { ...reply.info, id: "old", parentID: "older-user" }, parts: [{ type: "text", text: "Previous reply" }] };
  expect(assistantReactionTarget([old, user, reply], "reply")).toBe("user");
  expect(() => assistantReactionTarget([user, reply], "missing")).toThrow("current user");
  expect(() => assistantReactionTarget([user, { ...reply, parts: [{ type: "text", text: "I will check" }, ...reply.parts] }], "reply")).toThrow("first action");
  expect(() => assistantReactionTarget([user, { ...reply, info: { ...reply.info, id: "step1" }, parts: [{ type: "tool", tool: "read" }] }, reply], "reply")).toThrow("first action");
  expect(() => assistantReactionTarget([user, { ...reply, parts: [...reply.parts, ...reply.parts] }], "reply")).toThrow("first action");
  expect(() => assistantReactionTarget([user, reply, { ...user, info: { ...user.info, id: "new-user" } }], "reply")).toThrow("current user");
  expect(() => assistantReactionTarget([{ ...user, parts: [{ type: "text", text: "Delegation finished", synthetic: true }] }, reply], "reply")).toThrow("automated");
  expect(() => assistantReactionTarget([{ ...user, parts: [{ type: "text", text: "[Scheduled task: Morning briefing]\nCheck projects" }] }, reply], "reply")).toThrow("automated");
});
