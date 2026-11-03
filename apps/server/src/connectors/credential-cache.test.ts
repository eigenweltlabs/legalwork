import { expect, test } from "bun:test";
import { ConnectorCredentialCache } from "./credential-cache.js";

test("credentials survive browsing leases but expire a minute before provider expiry", async () => {
  let now = 1_000_000, loads = 0;
  const cache = new ConnectorCredentialCache(() => now);
  const load = async () => ({ accessToken: `token-${++loads}`, expiresAt: new Date(1_000_000 + 3_600_000).toISOString() });
  expect(await cache.get("profile", "account", false, load)).toBe("token-1");
  now += 300_000;
  expect(await cache.get("profile", "account", false, load)).toBe("token-1");
  now = 1_000_000 + 3_540_000;
  expect(await cache.get("profile", "account", false, load)).toBe("token-2");
});

test("unknown, malformed and near-expiry dates never create a reusable credential", async () => {
  const cache = new ConnectorCredentialCache(() => 1_000_000);
  for (const expiresAt of [null, "invalid", new Date(1_030_000).toISOString()]) {
    let loads = 0;
    const load = async () => ({ accessToken: `token-${++loads}`, expiresAt });
    await cache.get("profile", String(expiresAt), false, load);
    expect(await cache.get("profile", String(expiresAt), false, load)).toBe("token-2");
  }
});

test("concurrent retrievals share a result and profiles and account identities stay isolated", async () => {
  const cache = new ConnectorCredentialCache();
  let loads = 0;
  const load = async () => { loads++; await Promise.resolve(); return { accessToken: "secret", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; };
  expect(await Promise.all(Array.from({ length: 5 }, () => cache.get("profile", "alice", false, load)))).toEqual(Array(5).fill("secret"));
  await cache.get("profile", "bob", false, load);
  await cache.get("other-profile", "alice", false, load);
  expect(loads).toBe(3);
});

test("forced refresh replaces cached credentials and simultaneous refreshes are shared", async () => {
  const cache = new ConnectorCredentialCache();
  let loads = 0;
  const load = async () => { await Promise.resolve(); return { accessToken: `token-${++loads}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; };
  await cache.get("profile", "account", false, load);
  expect(await Promise.all([cache.get("profile", "account", true, load), cache.get("profile", "account", true, load)])).toEqual(["token-2", "token-2"]);
  expect(await cache.get("profile", "account", false, load)).toBe("token-2");
});

test("invalidation rejects an in-flight credential and a late response cannot refill the cache", async () => {
  const cache = new ConnectorCredentialCache();
  const deferred = Promise.withResolvers<{ accessToken: string; expiresAt: string | null }>();
  const pending = cache.get("profile", "account", false, () => deferred.promise).then(
    token => ({ token }), (error: unknown) => ({ error }),
  );
  cache.invalidate("profile");
  deferred.resolve({ accessToken: "old-session", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect(await pending).toMatchObject({ error: { code: "connector_account_changed" } });
  expect(await cache.get("profile", "account", false, async () => ({ accessToken: "new-session", expiresAt: null }))).toBe("new-session");
});

test("failed retrievals are not cached", async () => {
  const cache = new ConnectorCredentialCache();
  await expect(cache.get("profile", "account", false, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(await cache.get("profile", "account", false, async () => ({ accessToken: "recovered", expiresAt: null }))).toBe("recovered");
});

test("a late ordinary retrieval cannot overwrite a newer forced refresh", async () => {
  const cache = new ConnectorCredentialCache();
  const deferred = Promise.withResolvers<{ accessToken: string; expiresAt: string | null }>();
  const old = cache.get("profile", "account", false, () => deferred.promise).then(
    token => ({ token }), (error: unknown) => ({ error }),
  );
  const load = async () => ({ accessToken: "refreshed", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await cache.get("profile", "account", true, load);
  deferred.resolve({ accessToken: "stale", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect(await old).toMatchObject({ error: { code: "connector_account_changed" } });
  expect(await cache.get("profile", "account", false, load)).toBe("refreshed");
});
