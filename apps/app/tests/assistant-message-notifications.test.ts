import { expect, test } from "bun:test";
import type { LegalworkSessionMessage } from "../src/app/lib/legalwork-server";
import { AssistantMessageNotifications, assistantNotificationId, assistantNotificationTarget } from "../src/react-app/domains/session/sidebar/assistant-message-notifications";

function reply(id: string, completed?: number, text = "Your [briefing](briefings/today.md) is ready."): LegalworkSessionMessage {
  return {
    info: { id, sessionID: "today", role: "assistant", parentID: "user", modelID: "model", providerID: "provider", mode: "legalwork", agent: "legalwork", path: { cwd: "/assistant", root: "/assistant" }, time: { created: 90, completed }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: text ? [{ id: `part-${id}`, sessionID: "today", messageID: id, type: "text", text }] : [],
  };
}

test("only new completed prose triggers an alert, once, including a reply already running at startup", () => {
  const notifications = new AssistantMessageNotifications(100);
  expect(notifications.receive([reply("old", 99), reply("running"), reply("tools", 110, "")], true, false)).toBeNull();
  expect(notifications.receive([reply("running", 120)], true, false)).toEqual({ messageId: "running", completedAt: 120, body: "Your briefing is ready." });
  expect(notifications.receive([reply("running", 120)], true, false)).toBeNull();
  const summary = reply("summary", 130);
  if (summary.info.role === "assistant") summary.info.summary = true;
  const hidden = reply("hidden", 140);
  hidden.parts = [{ id: "internal", sessionID: "today", messageID: "hidden", type: "text", text: "Internal reminder", synthetic: true }];
  expect(notifications.receive([summary, hidden], true, false)).toBeNull();
});

test("foreground and muted replies are consumed without replaying when backgrounded or re-enabled", () => {
  const notifications = new AssistantMessageNotifications(100);
  expect(notifications.receive([reply("visible", 110)], true, true)).toBeNull();
  expect(notifications.receive([reply("visible", 110)], true, false)).toBeNull();
  expect(notifications.receive([reply("muted", 120)], false, false)).toBeNull();
  expect(notifications.receive([reply("muted", 120)], true, false)).toBeNull();
  expect(notifications.receive([reply("next", 130)], true, false)?.messageId).toBe("next");
});

test("reconnect batches show the latest reply once and notification clicks retain their chat target", () => {
  const notifications = new AssistantMessageNotifications(100);
  expect(notifications.receive([reply("final", 140), reply("update", 120)], true, false)?.messageId).toBe("final");
  expect(notifications.receive([reply("update", 120)], true, false)).toBeNull();
  expect(assistantNotificationTarget(assistantNotificationId("workspace/a", "chat:b", "reply"))).toEqual({ workspaceId: "workspace/a", sessionId: "chat:b" });
  expect(assistantNotificationTarget("tasks:new")).toBeNull();
  expect(assistantNotificationTarget("assistant-message:%broken:chat:reply")).toBeNull();
});
