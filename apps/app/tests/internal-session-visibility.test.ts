import { expect, test } from "bun:test";
import { isInternalSession } from "@legalwork/types/session-visibility";
import { upsertRuntimeSession } from "../src/react-app/shell/route-workspaces";

test("internal LegalMemory operations and review workers never become sidebar chats", () => {
  for (const metadata of [{ legalworkInternal: "legalmemory" }, { legalworkReviewWorker: true }]) {
    expect(isInternalSession({ metadata })).toBe(true);
    expect(upsertRuntimeSession([], { sessionId: "internal", info: { metadata } })).toEqual([]);
  }
  expect(isInternalSession({ metadata: { legalworkInternal: "ordinary-note" } })).toBe(false);
  expect(isInternalSession({ metadata: { legalworkReviewWorker: false } })).toBe(false);
  expect(isInternalSession({})).toBe(false);
});
