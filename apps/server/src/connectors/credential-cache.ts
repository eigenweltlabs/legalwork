import { ApiError } from "../errors.js";
import { runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";

type Credential = { accessToken: string; expiresAt: string | null };
type Entry = { until: number; token?: string; pending?: Promise<string>; forced: boolean };
type Scope = { generation: number; entries: Map<string, Entry> };

/** Process memory only. Authorization is checked independently of token validity. */
export class ConnectorCredentialCache {
  private scopes = new Map<string, Scope>();
  constructor(private now = () => Date.now()) {}
  private scope(key: string) {
    let scope = this.scopes.get(key);
    if (!scope) { scope = { generation: 0, entries: new Map() }; this.scopes.set(key, scope); }
    return scope;
  }
  generation(scope: string) { return this.scope(scope).generation; }
  invalidate(scope: string) {
    const current = this.scope(scope);
    current.generation++;
    current.entries.clear();
  }
  async get(scopeKey: string, key: string, force: boolean, load: () => Promise<Credential>): Promise<string> {
    const { entries } = this.scope(scopeKey);
    const current = entries.get(key);
    if (current && (!force || current.forced)) {
      if (current.pending) return current.pending;
      if (!force && current.token && current.until > this.now()) return current.token;
    }
    // A forced refresh supersedes a pending ordinary retrieval. Its late response
    // must not overwrite refreshed credentials or revive an invalidated account.
    const entry: Entry = { until: 0, forced: force };
    if (entries.size >= 256 && !entries.has(key)) entries.delete(entries.keys().next().value!);
    entries.set(key, entry);
    entry.pending = (async () => {
      try {
        const credential = await load();
        if (entries.get(key) !== entry) throw new ApiError(409, "connector_account_changed", "This connection changed while credentials were being retrieved. Try again.");
        const until = credential.expiresAt === null ? NaN : Date.parse(credential.expiresAt) - 60_000;
        if (Number.isFinite(until) && until > this.now()) {
          entry.until = until;
          entry.token = credential.accessToken;
        } else entries.delete(key); // Unknown or near expiry: use for this operation only.
        return credential.accessToken;
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      } finally { entry.pending = undefined; }
    })();
    return entry.pending;
  }
}

export const connectorCredentials = new ConnectorCredentialCache();
export const connectorCredentialScope = (config: ServerConfig) => runtimeDbPath(config);
export const invalidateConnectorCredentials = (config: ServerConfig) => connectorCredentials.invalidate(connectorCredentialScope(config));
