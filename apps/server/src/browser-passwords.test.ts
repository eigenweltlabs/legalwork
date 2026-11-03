import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserPasswordStore, browserPasswordOrigin } from "./browser-passwords.js";
import { OAuthVault } from "./file-storage/oauth/vault.js";

test("browser passwords share the encrypted vault without replacing OAuth entries, exposing values or losing concurrent edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-passwords-"));
  try {
    const vault = new OAuthVault(join(root, "test.vault")), store = new BrowserPasswordStore(vault);
    await vault.set("existing-oauth", { accessToken: "access", refreshToken: "refresh", expiresAt: 999 });
    const first = await store.save({ label: "Research", origin: "https://login.example.org/path", username: "lawyer", password: "fixture-secret-123" });
    expect(first.origin).toBe("https://login.example.org");
    expect(JSON.stringify(first)).not.toContain("fixture-secret-123");
    expect(JSON.stringify(await store.list())).not.toContain("password");
    expect((await readFile(vault.path)).includes(Buffer.from("fixture-secret-123"))).toBe(false);
    await Promise.all([
      store.save({ ...first, label: "Renamed", password: "" }),
      store.save({ label: "Other account", origin: first.origin, username: "other", password: "other-secret" }),
      vault.setEntry("other-consumer", z.object({ token: z.string() }), { token: "connector-token" }),
    ]);
    expect(await store.list(first.origin)).toHaveLength(2);
    expect(await store.list("https://example.org")).toHaveLength(2);
    expect(await store.list("https://auth.example.org/login")).toHaveLength(2);
    expect(await store.list("https://different.example.net")).toEqual([]);
    expect(await store.list("")).toEqual([]);
    expect((await store.get(first.id)).password).toBe("fixture-secret-123");
    expect((await store.get(first.id)).label).toBe("Renamed");
    expect(await vault.get("existing-oauth")).toEqual({ accessToken: "access", refreshToken: "refresh", expiresAt: 999 });
    expect(await vault.getEntry("other-consumer", z.object({ token: z.string() }))).toEqual({ token: "connector-token" });
    await store.save({ ...first, origin: "https://other.example.org", password: "" });
    expect((await store.get(first.id)).password).toBe("fixture-secret-123");
    await expect(store.save({ ...first, origin: "https://different.example.net", password: "" })).rejects.toThrow("Enter a password");
    await store.save({ ...first, password: "replacement" });
    expect((await new BrowserPasswordStore(new OAuthVault(vault.path)).get(first.id)).password).toBe("replacement");
    await store.delete(first.id);
    await expect(store.get(first.id)).rejects.toThrow("no longer exists");
    expect(await store.list()).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("website addresses reject unsafe URLs and preserve scheme and port", () => {
  for (const url of ["file:///tmp/password", "javascript:alert(1)", "http://example.org", "example.org"]) {
    expect(() => browserPasswordOrigin(url)).toThrow();
  }
  const authenticated = new URL("https://example.org");
  authenticated.username = "fixture-user";
  authenticated.password = "fixture-only-password";
  expect(() => browserPasswordOrigin(authenticated.href)).toThrow();
  expect(browserPasswordOrigin("https://LOGIN.Example.org:443/path?q=1")).toBe("https://login.example.org");
  expect(browserPasswordOrigin("http://127.0.0.1:8123/login")).toBe("http://127.0.0.1:8123");
});

test("website matching shares main domains and subdomains while separating unrelated sites and private tenants", () => {
  const store = new BrowserPasswordStore(new OAuthVault("unused-fixture.vault"));
  for (const [saved, current] of [
    ["https://www.deepl.com", "https://deepl.com/login"],
    ["https://www.deepl.com", "https://auth.deepl.com/login"],
    ["https://auth.deepl.com", "https://www.deepl.com"],
    ["https://login.firm.co.uk", "https://firm.co.uk"],
    ["https://login.firm.co.uk", "https://accounts.firm.co.uk"],
    ["https://a.github.io", "https://login.a.github.io"],
    ["https://bücher.de", "https://login.xn--bcher-kva.de"],
    ["http://127.0.0.1:8123", "http://127.0.0.1:8123/form"],
  ]) expect(store.matchesWebsite(saved, current)).toBe(true);
  for (const [saved, current] of [
    ["https://deepl.com", "https://notdeepl.com"],
    ["https://deepl.com", "https://deepl.com.evil.net"],
    ["https://firm.co.uk", "https://other.co.uk"],
    ["https://a.github.io", "https://b.github.io"],
    ["https://co.uk", "https://firm.co.uk"],
    ["https://deepl.com", "https://auth.deepl.com:444"],
    ["https://deepl.com", "http://auth.deepl.com"],
    ["http://127.0.0.1:8123", "http://127.0.0.1:8124"],
    ["https://127.0.0.1", "https://127.0.0.2"],
    ["https://deepl.com", "about:blank"],
  ]) expect(store.matchesWebsite(saved, current)).toBe(false);
});

test("one vault login retains multiple destinations across edits without expanding password domains", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-connections-"));
  try {
    const store = new BrowserPasswordStore(new OAuthVault(join(root, "test.vault")));
    const login = await store.save({ label: "SSO account", origin: "https://auth.example.com/login", websiteUrl: "https://research.example.org/?code=private#session", username: "fixture", password: "fixture-secret" });
    expect(login.websites).toEqual([{ name: "SSO account", url: "https://research.example.org/" }]);
    await Promise.all([
      store.connect(login.id, login.origin, { name: "Second product", url: "https://second.example.org/search", providerId: "second" }),
      store.save({ id: login.id, label: "Renamed", origin: login.origin, username: "fixture" }),
    ]);
    const connected = (await store.list())[0]!;
    expect(connected.websites).toHaveLength(2);
    expect(connected.label).toBe("Renamed");
    expect(await store.list("https://second.example.org")).toEqual([]);
    await store.connect(login.id, login.origin, { name: "Second product", url: "https://second.example.org/search", providerId: "second" });
    expect((await store.list())[0]!.websites).toHaveLength(2);
    await expect(store.connect(login.id, "https://unrelated.example", { name: "No", url: "https://another.example" })).rejects.toThrow();
    const changed = await store.save({ id: login.id, label: "New account", origin: "https://different.example", username: "fixture", password: "new-fixture" });
    expect(changed.websites).toEqual([{ name: "New account", url: "https://different.example/" }]);
    expect((await store.get(login.id)).password).toBe("new-fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("additional destinations and explicitly approved sign-in websites remain separate and preserve the existing secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websites-"));
  try {
    const vault = new OAuthVault(join(root, "test.vault")), store = new BrowserPasswordStore(vault);
    const login = await store.save({ label: "Research", origin: "https://360.lexisnexis.at", username: "fixture", password: "fixture-secret" });
    await store.addWebsite(login.id, { url: "https://plus.lexis.com/at?private=value#session" });
    expect(await store.list("https://signin.lexisnexis.com")).toEqual([]);
    const beforeSignIn = (await store.list())[0]!;
    const expanded = await store.addWebsite(login.id, { loginUrl: "https://SIGNIN.lexisnexis.com/login?private=value" });
    expect(expanded.additionalOrigins).toEqual(["https://signin.lexisnexis.com"]);
    expect(expanded.websites).toEqual(beforeSignIn.websites);
    expect(expanded.websites).toHaveLength(2);
    expect(expanded.websites[1]?.url).toBe("https://plus.lexis.com/at");
    expect((await store.list("https://signin.lexisnexis.com"))[0]?.id).toBe(login.id);
    expect(await store.list("https://signin.lexisnexis.com.evil.net")).toEqual([]);
    expect(await store.list("http://signin.lexisnexis.com")).toEqual([]);
    expect(await store.list("https://signin.lexisnexis.com:8443")).toEqual([]);
    await store.addWebsite(login.id, { url: "https://plus.lexis.com/at", loginUrl: "https://auth.lexisnexis.com" });
    expect((await store.get(login.id)).additionalOrigins).toEqual(["https://signin.lexisnexis.com"]);
    await store.save({ ...login, additionalOrigins: ["https://attacker.example"], password: "" });
    expect((await store.get(login.id)).additionalOrigins).toEqual(["https://signin.lexisnexis.com"]);
    expect(await store.list("https://attacker.example")).toEqual([]);
    expect((await store.get(login.id)).password).toBe("fixture-secret");
    await store.removeWebsite(login.id, { url: "https://plus.lexis.com/at" });
    expect(await store.list("https://signin.lexisnexis.com")).toHaveLength(1);
    await store.removeWebsite(login.id, { loginUrl: "https://signin.lexisnexis.com" });
    expect(await store.list("https://signin.lexisnexis.com")).toEqual([]);
    await expect(store.removeWebsite(login.id, { loginUrl: "https://360.lexisnexis.at" })).rejects.toThrow("primary sign-in website");
    await store.removeWebsite(login.id, { url: login.websites[0]!.url });
    expect((await new BrowserPasswordStore(new OAuthVault(vault.path)).get(login.id)).websites).toEqual([]);
    expect(JSON.stringify(await store.list())).not.toContain("fixture-secret");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("website metadata updates preserve provider fields, serialize concurrent additions and enforce limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-website-limits-"));
  try {
    const store = new BrowserPasswordStore(new OAuthVault(join(root, "test.vault")));
    const login = await store.save({ label: "Research", origin: "https://login.example.com", username: "fixture", password: "fixture-secret" });
    await store.connect(login.id, login.origin, { name: "Provider", url: "https://research.example.org", providerId: "example", country: "AT" });
    await Promise.all([
      store.addWebsite(login.id, { url: "https://research.example.org", name: "Renamed provider" }),
      store.addWebsite(login.id, { url: "https://other.example.org" }),
    ]);
    expect((await store.get(login.id)).websites).toHaveLength(3);
    expect((await store.get(login.id)).websites.find(site => site.providerId === "example")).toEqual({ name: "Renamed provider", url: "https://research.example.org/", providerId: "example", country: "AT" });
    await expect(store.addWebsite(login.id, { url: "http://insecure.example.org" })).rejects.toThrow();
    await expect(store.addWebsite(login.id, {})).rejects.toThrow();
    await expect(store.addWebsite(login.id, { name: "No URL" })).rejects.toThrow();
    await expect(store.addWebsite(login.id, { loginUrl: "http://insecure.example.org" })).rejects.toThrow();
    await expect(store.addWebsite(login.id, { url: "https://user:secret@example.org" })).rejects.toThrow();
    await expect(store.addWebsite(login.id, { url: "https://example.org", loginUrl: "http://insecure.example.org" })).rejects.toThrow();
    await expect(store.addWebsite(login.id, { url: "https://example.org", additionalOrigins: ["https://attacker.example"] })).rejects.toThrow();
    for (let index = 3; index < 32; index++) await store.addWebsite(login.id, { url: `https://research.example.org/${index}` });
    await expect(store.addWebsite(login.id, { url: "https://research.example.org/overflow" })).rejects.toThrow("at most 32");
    for (let index = 0; index < 32; index++) await store.addWebsite(login.id, { url: "https://research.example.org", loginUrl: `https://auth${index}.example.net` });
    // Subdomains already share a permitted site, so one explicit grant covers these.
    expect((await store.get(login.id)).additionalOrigins).toHaveLength(1);
    for (let index = 1; index < 32; index++) await store.addWebsite(login.id, { url: "https://research.example.org", loginUrl: `https://auth${index}.example` });
    await expect(store.addWebsite(login.id, { url: "https://research.example.org", loginUrl: "https://overflow.example" })).rejects.toThrow("at most 32");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy Austrian Lexis entries are repaired once without changing credentials or ambiguous records", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-lexis-migration-"));
  try {
    const vault = new OAuthVault(join(root, "test.vault")), store = new BrowserPasswordStore(vault);
    const base = { label: "Lexis", username: "fixture", password: "fixture-secret", updatedAt: "2026-10-30T00:00:00.000Z" };
    const direct = { ...base, id: randomUUID(), origin: "https://360.lexisnexis.at" };
    const preset = { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [
      { name: "Login", url: "https://signin.lexisnexis.com/" },
      { name: "Broken login", url: "https://signin.lexisnexis.com/lnaccess/app/signin" },
      { name: "Austrian research", url: "https://research.example.org", providerId: "lexis360-at", country: "AT" },
    ] };
    const plus = { ...base, id: randomUUID(), origin: "https://plus.lexis.com", websites: [{ name: "Lexis+ Austria", url: "https://plus.lexis.com/at" }] };
    const legacyEmpty = { ...base, id: randomUUID(), origin: "https://360.lexisnexis.at", websites: [] };
    const unaffected = [
      { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [{ name: "US", url: "https://plus.lexis.com/" }] },
      { ...base, id: randomUUID(), origin: "https://www.lexis360intelligence.fr.evil.net", websites: [{ name: "France", url: "https://www.lexis360intelligence.fr.evil.net/" }] },
      { ...base, id: randomUUID(), origin: "https://custom.example.org", websites: [{ name: "Lexis Austria", url: "https://custom.example.org" }] },
      { ...base, id: randomUUID(), origin: "https://360.lexisnexis.at.evil.net" },
      { ...base, id: randomUUID(), origin: "https://legacy.example.net", websites: [] },
    ];
    await vault.setEntry(JSON.stringify(["browser-passwords", 1]), z.array(z.unknown()), [direct, preset, plus, legacyEmpty, ...unaffected]);
    await Promise.all([store.list(), store.list()]);
    for (const original of [direct, preset, plus, legacyEmpty]) {
      const migrated = await store.get(original.id);
      expect(migrated.websites.map(site => site.url)).toContain("https://360.lexisnexis.at/");
      expect(migrated.websites.map(site => site.url)).toContain("https://plus.lexis.com/at");
      expect(migrated.password).toBe(original.password);
      expect(migrated.username).toBe(original.username);
      expect(migrated.origin).toBe(original.origin);
      expect(migrated.updatedAt).toBe(original.updatedAt);
      expect(migrated.migrationVersion).toBe(2);
    }
    expect((await store.get(direct.id)).additionalOrigins).toEqual(["https://signin.lexisnexis.com"]);
    expect((await store.get(plus.id)).additionalOrigins).toEqual(["https://signin.lexisnexis.com"]);
    expect((await store.get(legacyEmpty.id)).additionalOrigins).toEqual(["https://signin.lexisnexis.com"]);
    expect((await store.get(preset.id)).websites).toHaveLength(3);
    expect((await store.get(preset.id)).websites[0]).toEqual(preset.websites[2]);
    for (const original of unaffected) {
      const migrated = await store.get(original.id);
      expect(migrated.websites).toEqual("websites" in original && original.websites.length ? original.websites : [{ name: original.label, url: `${original.origin}/` }]);
      expect(migrated.additionalOrigins).toEqual([]);
    }
    const repaired = await readFile(vault.path);
    await store.list();
    expect(await readFile(vault.path)).toEqual(repaired);
    await store.removeWebsite(direct.id, { url: "https://360.lexisnexis.at/" });
    await store.removeWebsite(direct.id, { url: "https://plus.lexis.com/at", loginUrl: "https://signin.lexisnexis.com" });
    const reopened = await new BrowserPasswordStore(new OAuthVault(vault.path)).get(direct.id);
    expect(reopened.websites).toEqual([]);
    expect(reopened.additionalOrigins).toEqual([]);
    expect(reopened.password).toBe("fixture-secret");
    const legacy = unaffected[4]!;
    await store.removeWebsite(legacy.id, { url: legacy.origin });
    expect((await new BrowserPasswordStore(new OAuthVault(vault.path)).get(legacy.id)).websites).toEqual([]);
    expect(JSON.stringify(await store.list())).not.toContain("migrationVersion");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Lexis migration repairs each verified FR, UK and US product on shared accounts while preserving custom metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-lexis-regions-"));
  try {
    const vault = new OAuthVault(join(root, "test.vault")), store = new BrowserPasswordStore(vault);
    const base = { label: "Shared research", username: "fixture", password: "fixture-secret", updatedAt: "2026-10-30T00:00:00.000Z" };
    const generic = { name: "Login", url: "https://signin.lexisnexis.com/" };
    const countries = [
      { name: "French library", url: "https://www.lexis360intelligence.fr/", providerId: "lexis360-fr", country: "FR" },
      { name: "UK library", url: "https://plus.lexis.com/uk", providerId: "lexis-uk", country: "OTHER" },
      { name: "US library", url: "https://plus.lexis.com/", providerId: "lexis-us", country: "US" },
    ];
    const custom = { name: "Firm research", url: "https://custom.example.org/research?required=context", providerId: "custom-firm", country: "OTHER" };
    const shared = { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [generic, ...countries, custom] };
    const france = { ...base, id: randomUUID(), origin: "https://www.lexis360intelligence.fr" };
    const uk = { ...base, id: randomUUID(), origin: "https://plus.lexis.com", websites: [countries[1]!] };
    const us = { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [generic, { name: "US", url: "https://plus.lexis.com/" }] };
    const allRegions = { ...shared, id: randomUUID(), websites: [...shared.websites, { name: "Austria", url: "https://360.lexisnexis.at/", providerId: "lexis360-at", country: "AT" }] };
    const unknown = [
      { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [generic] },
      { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [{ name: "Lexis+ UK", url: "https://signin.lexisnexis.com/lnaccess/app/signin", country: "GB" }] },
      { ...base, id: randomUUID(), origin: "https://plus.lexis.com" },
      { ...base, id: randomUUID(), origin: "https://custom.example.org", websites: [{ name: "US", url: "https://plus.lexis.com/" }] },
    ];
    await vault.setEntry(JSON.stringify(["browser-passwords", 1]), z.array(z.unknown()), [shared, france, uk, us, allRegions, ...unknown]);
    expect((await store.get(shared.id)).websites).toEqual([...countries, custom]);
    for (const original of [shared, france, uk, us, allRegions]) {
      const migrated = await store.get(original.id);
      expect(migrated).toMatchObject({ id: original.id, origin: original.origin, password: original.password, username: original.username, updatedAt: original.updatedAt, migrationVersion: 2 });
      expect(migrated.websites).not.toContainEqual(generic);
      expect(store.matchesEntryWebsite(migrated, "https://signin.lexisnexis.com/lnaccess/app/signin")).toBe(true);
    }
    expect((await store.get(france.id)).websites).toEqual([{ name: "Shared research", url: "https://www.lexis360intelligence.fr/" }]);
    expect((await store.get(uk.id)).websites).toEqual([countries[1]!]);
    expect((await store.get(us.id)).websites).toEqual([{ name: "US", url: "https://plus.lexis.com/" }]);
    expect((await store.get(allRegions.id)).websites.map(site => site.url)).toEqual([
      ...countries.map(site => site.url), custom.url, "https://360.lexisnexis.at/", "https://plus.lexis.com/at",
    ]);
    for (const original of unknown) {
      const migrated = await store.get(original.id);
      expect(migrated.websites).toEqual("websites" in original ? original.websites : [{ name: original.label, url: `${original.origin}/` }]);
      expect(migrated.additionalOrigins).toEqual([]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("version 2 preserves earlier removals and grants, and never auto-repairs newly created entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-lexis-revocations-"));
  try {
    const vault = new OAuthVault(join(root, "test.vault")), store = new BrowserPasswordStore(vault);
    const base = { label: "Lexis", username: "fixture", password: "fixture-secret", updatedAt: "2026-10-30T00:00:00.000Z", migrationVersion: 1, additionalOrigins: [] };
    const generic = { name: "Login", url: "https://signin.lexisnexis.com/" };
    const cleaned = { ...base, id: randomUUID(), origin: "https://www.lexis360intelligence.fr", websites: [generic, { name: "France", url: "https://www.lexis360intelligence.fr/", providerId: "lexis360-fr", country: "FR" }] };
    const untouched = [
      { ...base, id: randomUUID(), origin: "https://www.lexis360intelligence.fr", websites: [] },
      { ...base, id: randomUUID(), origin: "https://360.lexisnexis.at", websites: [generic, { name: "Austria", url: "https://plus.lexis.com/at" }] },
      { ...base, id: randomUUID(), origin: "https://signin.lexisnexis.com", websites: [generic, { name: "Custom UK", url: "https://custom.example.org", providerId: "lexis-uk", country: "OTHER" }] },
      { ...base, id: randomUUID(), origin: "https://www.lexis360intelligence.fr", migrationVersion: 2, websites: [generic] },
    ];
    await vault.setEntry(JSON.stringify(["browser-passwords", 1]), z.array(z.unknown()), [cleaned, ...untouched]);
    expect((await store.get(cleaned.id)).websites).toEqual([cleaned.websites[1]!]);
    expect((await store.get(cleaned.id)).additionalOrigins).toEqual([]);
    for (const original of untouched) {
      const migrated = await store.get(original.id);
      expect(migrated).toEqual({ ...original, migrationVersion: 2 });
    }
    const saved = await store.save({ label: "New France login", origin: "https://www.lexis360intelligence.fr", username: "fixture", password: "new-secret" });
    const reopened = await new BrowserPasswordStore(new OAuthVault(vault.path)).get(saved.id);
    expect(reopened.migrationVersion).toBe(2);
    expect(reopened.additionalOrigins).toEqual([]);
    expect(reopened.websites).toEqual(saved.websites);
    await store.removeWebsite(cleaned.id, { url: cleaned.websites[1]!.url });
    expect((await new BrowserPasswordStore(new OAuthVault(vault.path)).get(cleaned.id)).websites).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Lexis destination repair never grants sign-in access to firm SSO, lookalike domains or alternate ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-lexis-sso-"));
  try {
    const vault = new OAuthVault(join(root, "test.vault")), store = new BrowserPasswordStore(vault);
    const websites = [
      { name: "Login", url: "https://signin.lexisnexis.com/" },
      { name: "France", url: "https://www.lexis360intelligence.fr/", providerId: "lexis360-fr", country: "FR" },
      { name: "UK", url: "https://plus.lexis.com/uk", providerId: "lexis-uk", country: "GB" },
      { name: "Austria", url: "https://360.lexisnexis.at/", providerId: "lexis360-at", country: "AT" },
    ];
    const originals = [
      "https://sso.firm.example",
      "https://360.lexisnexis.at.evil.net",
      "https://www.lexis360intelligence.fr.evil.net",
      "https://plus.lexis.com.evil.net",
      "https://360.lexisnexis.at:444",
      "https://www.lexis360intelligence.fr:444",
      "https://plus.lexis.com:444",
    ].map(origin => ({ id: randomUUID(), origin, label: "Firm SSO", username: "fixture", password: "fixture-secret", websites, updatedAt: "2026-10-30T00:00:00.000Z" }));
    await vault.setEntry(JSON.stringify(["browser-passwords", 1]), z.array(z.unknown()), originals);
    for (const original of originals) {
      const migrated = await store.get(original.id);
      expect(migrated).toMatchObject({ id: original.id, origin: original.origin, password: original.password, username: original.username, updatedAt: original.updatedAt, migrationVersion: 2 });
      expect(migrated.websites).toEqual([...websites.slice(1), { name: "Lexis+ Österreich", url: "https://plus.lexis.com/at" }]);
      expect(migrated.additionalOrigins).toEqual([]);
      expect(store.matchesEntryWebsite(migrated, "https://signin.lexisnexis.com")).toBe(false);
    }
    expect(await store.list("https://signin.lexisnexis.com")).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
