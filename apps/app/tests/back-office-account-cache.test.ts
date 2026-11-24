import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { syncBackOfficeCache } from "../src/react-app/infra/reset-back-office-cache";

test("account/policy changes clear Back Office data and ignore a late result while keeping unrelated caches", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const base = "http://fixture.test", key = ["back-office", base, "auto"];
  cache.setQueryData(["back-office-history", base, "old"], "Old confidential history");
  cache.setQueryData(["back-office", base, "archive"], "Old archived client");
  cache.setQueryData(["time-tracking-profile", base, "token"], { profileId: "previous" });
  cache.setQueryData(["timekeeping-conversation", base, "token", "previous"], { day: "previous chat" });
  cache.setQueryData(["documents", base], "Local document");
  let finish = (_value: string) => {};
  const request = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<string>(resolve => { finish = resolve; }) });
  const handled = request.catch(() => undefined);
  await syncBackOfficeCache(cache, base, { policy: true });
  cache.setQueryData(key, "New account");
  finish("Old response ignoring cancellation");
  await handled;
  expect(cache.getQueryData(key)).toBe("New account");
  expect(cache.getQueryData(["back-office-history", base, "old"])).toBeUndefined();
  expect(cache.getQueryData(["back-office", base, "archive"])).toBeUndefined();
  expect(cache.getQueryData(["time-tracking-profile", base, "token"])).toBeUndefined();
  expect(cache.getQueryData(["timekeeping-conversation", base, "token", "previous"])).toBeUndefined();
  expect(cache.getQueryData(["documents", base])).toBe("Local document");
  cache.clear();
});

test("engine reload bursts keep the authorized directory and its in-flight read", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const base = "http://fixture.test";
  const key = ["back-office", base, "auto", ["timesheets", 1]];
  const snapshot = { records: [] };
  cache.setQueryData(key, snapshot);
  let finish = () => {};
  const read = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<typeof snapshot>(resolve => { finish = () => resolve(snapshot); }) });
  for (let i = 0; i < 10; i++) await syncBackOfficeCache(cache, base, { reload: true });
  expect(cache.getQueryData(key)).toBe(snapshot);
  expect(cache.getQueryState(key)?.fetchStatus).toBe("fetching");
  finish();
  await read;
  cache.clear();
});
