import { expect, test } from "bun:test";
import { isAssistantConversation } from "../src/react-app/domains/session/chat/assistant-conversation";

test("daily Assistant routes are recognized without treating children or unresolved links as the Assistant", () => {
  expect(isAssistantConversation("today", "today")).toBe(true);
  expect(isAssistantConversation("yesterday", "today", {})).toBe(true);
  expect(isAssistantConversation("research", "today", { parentID: "today" })).toBe(false);
  expect(isAssistantConversation("nested", "today", { parentID: "research" })).toBe(false);
  expect(isAssistantConversation("unresolved", "today")).toBe(false);
  expect(isAssistantConversation(null, "today")).toBe(false);
});
