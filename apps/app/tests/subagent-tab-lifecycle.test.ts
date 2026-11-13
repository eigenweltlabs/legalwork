import { expect, test } from "bun:test";
import { chatPanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";
import { subagentTabLifecycle } from "../src/react-app/domains/session/panel/subagent-tab-lifecycle";

const tabs = [chatPanelTab("assistant", "Assistant"), chatPanelTab("child", "Research", "assistant"), chatPanelTab("nested", "Check", "child")];

test("background runs do not create tabs and completed results can be opened for inspection", () => {
  expect(subagentTabLifecycle([], { child: "thinking" }, new Set()).running.size).toBe(0);
  const result = subagentTabLifecycle(tabs, { assistant: "thinking", child: "idle", nested: "idle" }, new Set());
  expect(result.running.size).toBe(0);
  expect(result.completed).toEqual([]);
});

test("running child and nested tabs close on completion without closing the Assistant", () => {
  const active = subagentTabLifecycle(tabs, { assistant: "thinking", child: "responding", nested: "compacting" }, new Set());
  expect([...active.running]).toEqual(["child", "nested"]);
  const result = subagentTabLifecycle(tabs, { assistant: "idle", child: "idle", nested: "waiting" }, active.running);
  expect(result.completed).toEqual(["child"]);
  expect([...result.running]).toEqual(["nested"]);
  expect(subagentTabLifecycle(tabs, { nested: "idle" }, result.running).completed).toEqual(["nested"]);
});

test("refresh gaps, approvals and errors do not dismiss a running tab", () => {
  let running = new Set(["child"]);
  for (const statuses of [undefined, { child: "waiting" }, { child: "error" }] satisfies (Record<string, "waiting" | "error"> | undefined)[]) {
    const result = subagentTabLifecycle(tabs, statuses, running);
    expect(result.completed).toEqual([]);
    expect(result.running.has("child")).toBe(true);
    running = result.running;
  }
  expect(subagentTabLifecycle(tabs, { child: "idle" }, running).completed).toEqual(["child"]);
});

test("manually closing a running tab forgets it so reopening its result stays open", () => {
  const closed = subagentTabLifecycle(tabs.filter(tab => tab.id !== "chat:child"), { child: "responding" }, new Set(["child"]));
  expect(closed.running.has("child")).toBe(false);
  expect(subagentTabLifecycle(tabs, { child: "idle" }, closed.running).completed).toEqual([]);
});
