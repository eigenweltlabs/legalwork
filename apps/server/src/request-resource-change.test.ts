import { expect, test } from "bun:test";
import { requestResourceChange } from "./request-resource-change.js";

test("resource changes notify readers without treating execution or ordinary reads as writes", () => {
  const writes: Array<[string, string, NonNullable<ReturnType<typeof requestResourceChange>>]> = [
    ["POST", "/workspace/ws/reviews/id/start", "reviews"],
    ["PUT", "/workspace/ws/wiki-suggestions/id", "suggestions"],
    ["POST", "/workspace/ws/wiki-suggestions/id/save", "suggestions"],
    ["PUT", "/workspace/ws/ui-views/report", "views"],
    ["PATCH", "/sandbox/settings", "sandbox"],
    ["PATCH", "/workspace/ws/sandbox/session/chat", "sandbox"],
  ];
  for (const [method, path, resource] of writes) expect(requestResourceChange(method, path)).toBe(resource);
  for (const [method, path] of [
    ["GET", "/workspace/ws/reviews/id"], ["GET", "/workspace/ws/ui-views"],
    ["POST", "/workspace/ws/reviews/wait"],
    ["POST", "/workspace/ws/reviews/id/rows/query"],
    ["POST", "/workspace/ws/reviews/id/results/query"],
    ["POST", "/workspace/ws/sandbox/web"], ["POST", "/workspace/ws/sandbox/execute"],
    ["POST", "/analytics/events"],
  ]) expect(requestResourceChange(method!, path!)).toBeNull();
});
