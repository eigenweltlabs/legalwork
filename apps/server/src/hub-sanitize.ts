/**
 * Secret-stripping serializers for Firm Hub *share templates*.
 *
 * When a firm shares an integration (MCP server entry) or a settings preset,
 * we publish a REUSABLE TEMPLATE — never the sharer's credentials. The installer
 * re-supplies their own auth. This module removes any secret-shaped material
 * before a payload leaves the machine.
 *
 * The Eigenwelt platform ALSO validates and returns 400 for any payload that
 * still contains a secret-shaped key, so this stripping must be thorough: it is
 * the first (and authoritative, from the app's perspective) line of defense.
 *
 * Rule of thumb: drop, don't mask. A dropped key can't leak; an emptied value
 * can't either, but a dropped key also keeps the template clean.
 */

/**
 * Matches property names that carry (or are named after) a credential.
 * Unanchored on purpose so it also catches `X-Api-Key`, `OPENAI_API_KEY`,
 * `githubToken`, `clientSecret`, etc.
 */
export const HUB_SECRET_KEY_REGEX =
  /(?:api[_-]?key|secret|token|password|authorization|bearer|credential|private[_-]?key|client[_-]?secret|access[_-]?token)/i;

/** True when a property name looks like it holds a secret. */
export function isSecretKey(key: string): boolean {
  return HUB_SECRET_KEY_REGEX.test(key);
}

/** Auth-scheme values we blank out even when the key name looks innocuous. */
const AUTH_VALUE_REGEX = /^\s*(?:bearer|basic|token|apikey|api-key)\s+\S/i;
const SECRET_VALUE_REGEX = /(?:\bBearer\s+\S+|\b(?:ghp|gho|github_pat|xox[baprs]|sk|rk|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively drop every property whose KEY matches {@link HUB_SECRET_KEY_REGEX}.
 * Additionally, inside auth-bearing containers (`headers` / `env`), blank any
 * remaining string value that carries an auth scheme (e.g. `Bearer eyJ…`) even
 * if its key name is innocuous.
 *
 * `valueIsAuthMap` is true when `value` itself is a `headers`/`env` object, so
 * its direct string members are treated as auth values.
 */
export function stripSecrets(value: unknown, valueIsAuthMap = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item, false));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretKey(key)) continue; // drop secret-shaped keys entirely
      if (valueIsAuthMap && typeof child === "string" && AUTH_VALUE_REGEX.test(child)) {
        out[key] = ""; // blank an auth-scheme value under an innocuous header/env key
        continue;
      }
      out[key] = stripSecrets(child, key === "headers" || key === "env");
    }
    return out;
  }
  return value;
}

/**
 * Strip secrets from an MCP server entry before sharing it as an integration
 * template. Removes api keys / tokens / passwords wherever they hide (top level,
 * `headers`, `env`, nested options) so only the connection shape survives.
 */
export function sanitizeIntegrationMcp(config: Record<string, unknown>): Record<string, unknown> {
  const enabled = typeof config.enabled === "boolean" ? config.enabled : undefined;
  if (config.type === "remote" && typeof config.url === "string") {
    const url = new URL(config.url);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretKey(key) || /^key$/i.test(key)) url.searchParams.delete(key);
    }
    return {
      type: "remote",
      url: url.toString(),
      ...(enabled === undefined ? {} : { enabled }),
    };
  }
  if (config.type === "local" && Array.isArray(config.command)) {
    const command: string[] = [];
    let dropNext = false;
    for (const raw of config.command) {
      if (typeof raw !== "string") continue;
      if (dropNext) {
        dropNext = false;
        continue;
      }
      const [flag = ""] = raw.replace(/^--?/, "").split("=", 1);
      const isSecretFlag = raw.startsWith("-") && (isSecretKey(flag) || /^key$/i.test(flag));
      if (isSecretFlag) {
        dropNext = !raw.includes("=");
        continue;
      }
      if (SECRET_VALUE_REGEX.test(raw)) continue;
      if (/^https?:\/\//i.test(raw)) {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()]) {
          if (isSecretKey(key) || /^key$/i.test(key)) url.searchParams.delete(key);
        }
        command.push(url.toString());
      } else {
        command.push(raw);
      }
    }
    return {
      type: "local",
      command,
      ...(enabled === undefined ? {} : { enabled }),
    };
  }
  return stripSecrets(config) as Record<string, unknown>;
}

/** The only opencode settings keys a shared preset is allowed to carry. */
export const SAFE_PRESET_KEYS = ["provider", "model", "small_model"] as const;

/**
 * Reduce an opencode config to the safe, shareable preset fragment: the
 * `provider` shape (with every apiKey/secret stripped), plus `model` /
 * `small_model` defaults. Everything else is dropped.
 */
export function sanitizePresetFragment(fragment: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_PRESET_KEYS) {
    const value = fragment[key];
    if (value === undefined) continue;
    out[key] = key === "provider" ? stripSecrets(value) : value;
  }
  return out;
}

/**
 * Defensive assertion: walk a value and report whether ANY key still looks like
 * a secret. Used by tests (and callers that want a belt-and-braces check) to
 * guarantee a sanitized payload will survive the platform's own validation.
 */
export function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSecretKey(item));
  if (isPlainObject(value)) {
    return Object.entries(value).some(
      ([key, child]) => isSecretKey(key) || containsSecretKey(child),
    );
  }
  return false;
}
