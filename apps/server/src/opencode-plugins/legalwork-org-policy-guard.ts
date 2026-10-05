import { serverToken, serverUrl } from "./office-plugin-shared.js";

/**
 * The firm's policy, checked at every tool call (server: org-policy-engine.ts).
 * The engine's config already carries what the firm enforces, so the engine
 * asks or refuses by itself. This is the backstop for a config that was
 * changed anyway, e.g. by a file an agent wrote: a call the policy denies is
 * refused, and while the running engine's rules are looser than the firm's,
 * every call they cover is refused until the server has restored and reloaded
 * them. A connector the firm does not allow is refused too.
 */

type Action = "allow" | "ask" | "deny";
type Rule = Action | Record<string, Action>;
type Guard = { orgName: string; permission: Record<string, Rule>; blockedMcpServers: string[] };
type PluginInput = {
  directory?: string;
  client?: { config?: { get?: (options?: { query?: { directory?: string } }) => Promise<{ data?: unknown }> } };
};

const CACHE_MS = 3_000;
const STRICTNESS: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny";
}

function ruleOf(value: unknown): Rule | null {
  if (isAction(value)) return value;
  if (!isRecord(value)) return null;
  const rules: Record<string, Action> = {};
  for (const [pattern, action] of Object.entries(value)) if (isAction(action)) rules[pattern] = action;
  return rules;
}

/** The engine's wildcard matching (opencode core util/wildcard). */
function matches(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"));
}

/** As the engine evaluates a rule: the last matching pattern wins, "ask" without one. */
function evaluate(rule: Rule, input: string): Action {
  if (typeof rule === "string") return rule;
  let action: Action = "ask";
  for (const [pattern, next] of Object.entries(rule)) if (matches(input, pattern)) action = next;
  return action;
}

/** The permission a tool call needs, and what it applies to. */
function permissionOf(tool: string, args: unknown): { permission: string; input: string } | null {
  const value = (key: string) => (isRecord(args) && typeof args[key] === "string" ? args[key] : "*");
  if (tool === "bash") return { permission: "bash", input: value("command") };
  if (EDIT_TOOLS.has(tool)) return { permission: "edit", input: value("filePath") };
  if (tool === "webfetch") return { permission: "webfetch", input: value("url") };
  return null;
}

function parseGuard(value: unknown): Guard | null {
  if (!isRecord(value) || !isRecord(value.permission)) return null;
  const permission: Record<string, Rule> = {};
  for (const [key, raw] of Object.entries(value.permission)) {
    const rule = ruleOf(raw);
    if (rule) permission[key] = rule;
  }
  return {
    orgName: typeof value.orgName === "string" && value.orgName ? value.orgName : "Your organization",
    permission,
    blockedMcpServers: Array.isArray(value.blockedMcpServers) ? value.blockedMcpServers.filter((name) => typeof name === "string") : [],
  };
}

let guardCache: { at: number; guard: Guard | null } | null = null;

async function readGuard(): Promise<Guard | null> {
  if (guardCache && Date.now() - guardCache.at < CACHE_MS) return guardCache.guard;
  // Unreachable (the server restarting): the last answer stands.
  let guard = guardCache?.guard ?? null;
  try {
    const response = await fetch(`${serverUrl()}/org-policy/guard`, {
      headers: { Authorization: `Bearer ${serverToken()}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) guard = parseGuard(await response.json());
    else if (response.status === 404) guard = null;
  } catch {
    // Kept from before.
  }
  guardCache = { at: Date.now(), guard };
  return guard;
}

const engineCache = new Map<string, { at: number; rules: Rule[] }>();

/** The running engine's rules for `permission`: top level and per agent. */
async function engineRules(input: PluginInput | undefined, permission: string): Promise<Rule[] | null> {
  // Called on the SDK's config object: its methods need their `this`.
  const sdkConfig = input?.client?.config;
  if (!sdkConfig?.get) return null;
  const key = `${input?.directory ?? ""}:${permission}`;
  const cached = engineCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rules;
  try {
    const result = await sdkConfig.get({ query: input?.directory ? { directory: input.directory } : undefined });
    const config = isRecord(result.data) ? result.data : {};
    const rules: Rule[] = [];
    const top = isRecord(config.permission) ? ruleOf(config.permission[permission]) : null;
    if (top) rules.push(top);
    for (const agent of isRecord(config.agent) ? Object.values(config.agent) : []) {
      const rule = isRecord(agent) && isRecord(agent.permission) ? ruleOf(agent.permission[permission]) : null;
      if (rule) rules.push(rule);
    }
    engineCache.set(key, { at: Date.now(), rules });
    return rules;
  } catch {
    return null;
  }
}

function refusal(orgName: string, what: string): Error {
  return new Error(
    `${orgName} does not allow ${what} on this computer. This is your organization's policy: do not try another way; tell the user what you could not do.`,
  );
}

export const LegalWorkOrgPolicyGuard = async (pluginInput?: PluginInput) => ({
  "tool.execute.before": async (input: { tool: string }, output: { args: unknown }) => {
    const guard = await readGuard();
    if (!guard) return;
    for (const server of guard.blockedMcpServers) {
      if (input.tool.startsWith(`${server}_`)) throw refusal(guard.orgName, `the connector "${server}"`);
    }
    const call = permissionOf(input.tool, output.args);
    const rule = call ? guard.permission[call.permission] : undefined;
    if (!call || !rule) return;
    const required = evaluate(rule, call.input);
    if (required === "deny") throw refusal(guard.orgName, `this ${call.permission} action`);
    // The engine asks where the firm wants it to, unless its rules were loosened.
    const rules = await engineRules(pluginInput, call.permission);
    if (rules?.some((engineRule) => STRICTNESS[evaluate(engineRule, call.input)] < STRICTNESS[required])) {
      throw refusal(guard.orgName, `this ${call.permission} action until its settings are restored`);
    }
  },
});
