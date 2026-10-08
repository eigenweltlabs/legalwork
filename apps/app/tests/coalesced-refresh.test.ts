import { expect, test } from "bun:test";
import { createCoalescedRefresh } from "../src/react-app/shell/coalesced-refresh";

const deferred = () => { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
test("a removal refresh supersedes an older list response and all callers await the new list", async () => {
  const first = deferred(), second = deferred(), began = deferred();
  const applied: number[] = []; let calls = 0;
  const refresh = createCoalescedRefresh(async current => {
    const call = ++calls;
    if (call === 1) { began.resolve(); await first.promise; } else await second.promise;
    if (current()) applied.push(call);
  });
  const a = refresh(); await began.promise;
  const b = refresh(); const c = refresh();
  expect(b).toBe(a); expect(c).toBe(a);
  first.resolve(); await Promise.resolve();
  expect(applied).toEqual([]);
  second.resolve(); await Promise.all([a, b, c]);
  expect(calls).toBe(2); expect(applied).toEqual([2]);
});
test("a failed refresh does not prevent a later retry", async () => {
  let calls = 0;
  const refresh = createCoalescedRefresh(async () => { if (++calls === 1) throw new Error("offline"); });
  await expect(refresh()).rejects.toThrow("offline");
  await refresh(); expect(calls).toBe(2);
});
