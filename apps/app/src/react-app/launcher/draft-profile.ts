const profiles = new Map<string, Promise<string>>();

export function hashDraftProfile(key: string): Promise<string> {
  const known = profiles.get(key);
  if (known) return known;
  const profile = crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)).then(bytes =>
    Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join(""));
  profiles.set(key, profile);
  return profile;
}

const cacheScopes = new Map<string, number>();

export function draftCacheScope(key?: string): number {
  if (!key) return 0;
  let scope = cacheScopes.get(key);
  if (scope === undefined) {
    scope = cacheScopes.size + 1;
    cacheScopes.set(key, scope);
  }
  return scope;
}
