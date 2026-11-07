import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { resetBackOfficeCache } from "../src/react-app/infra/reset-back-office-cache";

test("account/policy changes clear Back Office data and ignore a late result while keeping unrelated caches", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const base = "http://fixture.test", key = ["back-office", base, "auto"];
  cache.setQueryData(["back-office-history", base, "old"], "Old confidential history");
  cache.setQueryData(["back-office", base, "archive"], "Old archived client");
  cache.setQueryData(["documents", base], "Local document");
  let finish = (_value: string) => {};
  const request = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<string>(resolve => { finish = resolve; }) });
  const handled = request.catch(() => undefined);
  await resetBackOfficeCache(cache, base);
  cache.setQueryData(key, "New account");
  finish("Old response ignoring cancellation");
  await handled;
  expect(cache.getQueryData(key)).toBe("New account");
  expect(cache.getQueryData(["back-office-history", base, "old"])).toBeUndefined();
  expect(cache.getQueryData(["back-office", base, "archive"])).toBeUndefined();
  expect(cache.getQueryData(["documents", base])).toBe("Local document");
  cache.clear();
});
