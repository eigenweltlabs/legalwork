import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectedWebsiteSchema, websiteConnectionUrl } from "./native-shared-values.js";
import type { ConnectedWebsite } from "@legalwork/types/browser-password-request";
import { getDomain } from "tldts";
import { ApiError } from "./errors.js";
import { OAuthVault, oauthVaultPath, vaultLock } from "./file-storage/oauth/vault.js";
import type { ServerConfig } from "./types.js";

const entry = z.object({
  id: z.string().uuid(), label: z.string().trim().min(1).max(200),
  origin: z.string(), username: z.string().max(500),
  additionalOrigins: z.array(z.string()).default([]),
  migrationVersion: z.number().int().nonnegative().default(0),
  websites: z.array(connectedWebsiteSchema).optional(),
  password: z.string().min(1).max(10000), updatedAt: z.string(),
}).transform(value => ({ ...value, websites: value.websites === undefined || value.migrationVersion === 0 && value.websites.length === 0
  ? [{ name: value.label, url: browserWebsiteUrl(value.origin) }] : value.websites }));
const entries = z.array(entry);
const input = z.object({
  label: z.string().trim().min(1).max(200), username: z.string().max(500),
  id: z.string().uuid().optional(), origin: z.string().min(1).max(2000),
  password: z.string().max(10000).optional(), websiteUrl: websiteConnectionUrl.optional(),
});
const websiteInput = z.object({ url: websiteConnectionUrl.optional(), name: z.string().trim().min(1).max(200).optional(), loginUrl: websiteConnectionUrl.optional() }).strict()
  .refine(value => value.url !== undefined || value.loginUrl !== undefined)
  .refine(value => value.name === undefined || value.url !== undefined);
const websiteRemoval = z.object({ url: websiteConnectionUrl.optional(), loginUrl: websiteConnectionUrl.optional() }).strict()
  .refine(value => value.url !== undefined || value.loginUrl !== undefined);
const MAX_WEBSITES = 32;
const key = JSON.stringify(["browser-passwords", 1]);
type Entry = z.infer<typeof entry>;
function summary(value: Entry) {
  return { id: value.id, label: value.label, origin: value.origin, additionalOrigins: value.additionalOrigins, username: value.username, updatedAt: value.updatedAt, websites: value.websites };
}

export function browserWebsiteUrl(value: string) {
  browserPasswordOrigin(value);
  const url = new URL(value);
  url.search = ""; url.hash = "";
  return url.href;
}

export function browserPasswordOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "invalid_password_origin", "Enter a complete HTTPS website address."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new ApiError(400, "invalid_password_origin", "Use HTTPS for browser passwords (HTTP is supported only on localhost).");
  }
  return url.origin;
}

function website(value: string) {
  const url = new URL(browserPasswordOrigin(value));
  // Private suffixes keep independently owned sites such as a.github.io separate.
  url.hostname = getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  return url.origin;
}

function migrateAustrianLexis(value: Entry): Entry {
  if (value.migrationVersion >= 1) return value;
  const isAustrianAddress = (address: string) => {
    try {
      const url = new URL(address);
      return url.origin === "https://360.lexisnexis.at" || url.origin === "https://plus.lexis.com" && ["/at", "/at/"].includes(url.pathname);
    } catch { return false; }
  };
  if (!isAustrianAddress(value.origin) && !value.websites.some(site => site.providerId === "lexis360-at" || isAustrianAddress(site.url)))
    return { ...value, migrationVersion: 1 };
  const websites = value.websites.filter(site => {
    try {
      const url = new URL(site.url);
      return !(url.origin === "https://signin.lexisnexis.com" && ["/", "/lnaccess/app/signin", "/lnaccess/app/signin/"].includes(url.pathname) && !url.search);
    } catch { return true; }
  }).map(site => site.url === "https://360.lexisnexis.at" ? { ...site, url: "https://360.lexisnexis.at/" }
    : site.url === "https://plus.lexis.com/at/" ? { ...site, url: "https://plus.lexis.com/at" } : site);
  for (const site of [
    { name: "Lexis 360 Österreich", url: "https://360.lexisnexis.at/" },
    { name: "Lexis+ Österreich", url: "https://plus.lexis.com/at" },
  ]) {
    if (!websites.some(existing => {
      try { return browserWebsiteUrl(existing.url).replace(/\/$/, "") === site.url.replace(/\/$/, ""); } catch { return false; }
    })) websites.push(site);
  }
  const signinCovered = [value.origin, ...value.additionalOrigins].some(origin => {
    try { return website(origin) === website("https://signin.lexisnexis.com"); } catch { return false; }
  });
  const additionalOrigins = !signinCovered
    ? [...value.additionalOrigins, "https://signin.lexisnexis.com"] : value.additionalOrigins;
  return { ...value, websites, additionalOrigins, migrationVersion: 1 };
}

/** A separate namespace in the existing vault; never exported as environment variables. */
export class BrowserPasswordStore {
  constructor(readonly vault: OAuthVault) {}
  private async readCurrent() {
    const current = await this.vault.getEntry(key, entries) ?? [];
    if (current.every(value => value.migrationVersion >= 1)) return current;
    const migrated = current.map(migrateAustrianLexis);
    await this.vault.setEntry(key, entries, migrated);
    return migrated;
  }
  private async read() { return vaultLock(`${this.vault.path}:${key}`, () => this.readCurrent()); }
  matchesWebsite(saved: string, current: string) {
    try { return website(saved) === website(current); } catch { return false; }
  }
  matchesEntryWebsite(saved: Pick<Entry, "origin" | "additionalOrigins">, current: string) {
    return [saved.origin, ...saved.additionalOrigins].some(origin => this.matchesWebsite(origin, current));
  }
  async list(origin?: string) {
    return (await this.read()).filter(value => origin === undefined || this.matchesEntryWebsite(value, origin)).map(summary);
  }
  async get(id: string) {
    const value = (await this.read()).find(value => value.id === id);
    if (!value) throw new ApiError(404, "browser_password_not_found", "The saved browser password no longer exists.");
    return value;
  }
  async save(raw: unknown) {
    const parsed = input.safeParse(raw);
    if (!parsed.success) throw new ApiError(400, "invalid_browser_password", "Enter a label, website and password of at most 10,000 characters.");
    const value = parsed.data, origin = browserPasswordOrigin(value.origin);
    return vaultLock(`${this.vault.path}:${key}`, async () => {
      const current = await this.readCurrent(), previous = current.find(item => item.id === value.id);
      if (value.id && !previous) throw new ApiError(404, "browser_password_not_found", "The saved browser password no longer exists.");
      const sameWebsite = previous && this.matchesWebsite(previous.origin, origin);
      const password = value.password || (sameWebsite ? previous.password : undefined);
      if (!password) throw new ApiError(400, "browser_password_required", "Enter a password when adding an entry or changing its website.");
      const websites = sameWebsite ? previous.websites : [];
      const additionalOrigins = sameWebsite ? previous.additionalOrigins : [];
      const url = value.websiteUrl ? browserWebsiteUrl(value.websiteUrl) : sameWebsite ? undefined : browserWebsiteUrl(value.origin);
      const next = entry.parse({ ...value, migrationVersion: 1, additionalOrigins, websites: url ? [...websites.filter(site => site.url !== url), { ...websites.find(site => site.url === url), name: value.label, url }] : websites, origin, password, id: previous?.id ?? randomUUID(), updatedAt: new Date().toISOString() });
      if (next.websites.length > MAX_WEBSITES) throw new ApiError(400, "browser_password_website_limit", "A saved login can have at most 32 website destinations.");
      await this.vault.setEntry(key, entries, [...current.filter(item => item.id !== next.id), next]);
      return summary(next);
    });
  }
  /** Attach a destination to the same encrypted login, including separate-domain SSO. */
  async connect(id: string, loginUrl: string, website: ConnectedWebsite) {
    const site = connectedWebsiteSchema.parse({ ...website, url: browserWebsiteUrl(website.url) });
    return vaultLock(`${this.vault.path}:${key}`, async () => {
      const current = await this.readCurrent(), previous = current.find(item => item.id === id);
      if (!previous || !this.matchesEntryWebsite(previous, loginUrl)) throw new ApiError(400, "research_login_mismatch", "Choose a saved login for this website's sign-in address.");
      const next = { ...previous, websites: [...previous.websites.filter(item => item.url !== site.url), site], updatedAt: new Date().toISOString() };
      if (next.websites.length > MAX_WEBSITES) throw new ApiError(400, "browser_password_website_limit", "A saved login can have at most 32 website destinations.");
      await this.vault.setEntry(key, entries, current.map(item => item.id === id ? next : item));
      return summary(next);
    });
  }
  /** Navigation URLs never authorize password filling without an explicit sign-in URL. */
  async addWebsite(id: string, raw: unknown) {
    const parsed = websiteInput.safeParse(raw);
    if (!parsed.success) throw new ApiError(400, "invalid_browser_password_website", "Enter a valid website destination and, if needed, its sign-in address.");
    const { name, loginUrl } = parsed.data, url = parsed.data.url ? browserWebsiteUrl(parsed.data.url) : undefined;
    const loginOrigin = loginUrl ? browserPasswordOrigin(loginUrl) : undefined;
    return vaultLock(`${this.vault.path}:${key}`, async () => {
      const current = await this.readCurrent(), previous = current.find(item => item.id === id);
      if (!previous) throw new ApiError(404, "browser_password_not_found", "The saved browser password no longer exists.");
      const existing = previous.websites.find(site => site.url === url);
      const additionalOrigins = loginOrigin && !this.matchesEntryWebsite(previous, loginOrigin) ? [...previous.additionalOrigins, loginOrigin] : previous.additionalOrigins;
      const websites = url ? [...previous.websites.filter(site => site.url !== url), { ...existing, name: name ?? existing?.name ?? previous.label, url }] : previous.websites;
      if (websites.length > MAX_WEBSITES || additionalOrigins.length > MAX_WEBSITES)
        throw new ApiError(400, "browser_password_website_limit", "A saved login can have at most 32 website destinations and 32 additional sign-in websites.");
      const next = { ...previous, websites, additionalOrigins, updatedAt: new Date().toISOString() };
      await this.vault.setEntry(key, entries, current.map(item => item.id === id ? next : item));
      return summary(next);
    });
  }
  async removeWebsite(id: string, raw: unknown) {
    const parsed = websiteRemoval.safeParse(raw);
    if (!parsed.success) throw new ApiError(400, "invalid_browser_password_website", "Choose a website destination or additional sign-in address to remove.");
    const url = parsed.data.url ? browserWebsiteUrl(parsed.data.url) : undefined;
    const loginOrigin = parsed.data.loginUrl ? browserPasswordOrigin(parsed.data.loginUrl) : undefined;
    return vaultLock(`${this.vault.path}:${key}`, async () => {
      const current = await this.readCurrent(), previous = current.find(item => item.id === id);
      if (!previous) throw new ApiError(404, "browser_password_not_found", "The saved browser password no longer exists.");
      if (loginOrigin && this.matchesWebsite(previous.origin, loginOrigin))
        throw new ApiError(400, "browser_password_primary_origin", "The primary sign-in website cannot be removed. Edit or delete the saved login instead.");
      const next = { ...previous, websites: url ? previous.websites.filter(site => site.url !== url) : previous.websites,
        additionalOrigins: loginOrigin ? previous.additionalOrigins.filter(origin => !this.matchesWebsite(origin, loginOrigin)) : previous.additionalOrigins,
        updatedAt: new Date().toISOString() };
      await this.vault.setEntry(key, entries, current.map(item => item.id === id ? next : item));
      return summary(next);
    });
  }
  async delete(id: string) {
    return vaultLock(`${this.vault.path}:${key}`, async () => {
      const current = await this.readCurrent();
      if (!current.some(value => value.id === id)) throw new ApiError(404, "browser_password_not_found", "The saved browser password no longer exists.");
      await this.vault.setEntry(key, entries, current.filter(value => value.id !== id));
    });
  }
}

export function browserPasswords(config: Pick<ServerConfig, "configPath">) {
  return new BrowserPasswordStore(new OAuthVault(oauthVaultPath(config)));
}
