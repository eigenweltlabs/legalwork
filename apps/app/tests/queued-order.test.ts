import { expect, test } from "bun:test";
import { reconcileQueuedOrder } from "../src/react-app/domains/session/surface/queued-order";

test("a drag keeps surviving drafts ordered and appends messages arriving from another window", () => {
  expect(reconcileQueuedOrder(["third", "running", "second"], ["second", "third", "new"])).toEqual(["third", "second", "new"]);
  expect(reconcileQueuedOrder(["removed"], [])).toEqual([]);
  expect(reconcileQueuedOrder(["second", "second"], ["first", "second"])).toEqual(["second", "first"]);
});
