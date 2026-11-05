import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { serverToken, serverUrl } from "./office-plugin-shared.js";

const action = z.enum(["allow", "ask", "deny"]);
const guardSchema = z.object({ orgName: z.string().nullable(),
  permission: z.array(z.object({ action: z.string(), resource: z.string(), effect: action })),
  blockedMcpServers: z.array(z.string()), allowedProviders: z.array(z.string()).nullable(),
});
type Guard = z.infer<typeof guardSchema>;
const STRICTNESS = { allow: 0, ask: 1, deny: 2 };
const CACHE_MS = 3_000; // Existing policy freshness interval.

function matches(input: string, pattern: string): boolean {
  let source = pattern.replaceAll("\\", "/").replace(/[.+^$()|{}[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?";
  return new RegExp("^" + source + "$", process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"));
}
function required(guard: Guard, name: string, resources: readonly string[]) {
  let effect: z.infer<typeof action> = "allow";
  for (const rule of guard.permission) {
    if (!matches(name, rule.action)) continue;
    for (const resource of resources) {
      if (!matches(resource, rule.resource)) continue;
      const next = rule.effect;
      if (STRICTNESS[next] > STRICTNESS[effect]) effect = next;
    }
  }
  return effect;
}
function blockedConnector(guard: Guard, tool: string) {
  return guard.blockedMcpServers.find(server => tool.startsWith(server + "_"));
}
function refusal(orgName: string | null, what: string): Error {
  return new Error((orgName ?? "Your organization") + " does not allow " + what + " on this computer. This is your organization's policy: do not try another way; tell the user what you could not do.");
}

/** Native permission evaluation runs after saved approvals. Raise its effect
 * to the firm's minimum instead of inspecting or patching engine config files. */
export const LegalWorkOrgPolicyGuard = Plugin.define({ id: "legalwork.org-policy-guard", async setup(ctx) {
  let cache: { at: number; guard: Guard } | undefined;
  let pending: Promise<Guard> | undefined;
  const readGuard = async (): Promise<Guard> => {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.guard;
    pending ??= (async () => {
      try {
        const response = await fetch(serverUrl() + "/org-policy/guard", {
          headers: { Authorization: "Bearer " + serverToken() }, signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("Policy lookup failed (" + response.status + ")");
        const guard = guardSchema.parse(await response.json());
        cache = { at: Date.now(), guard };
        return guard;
      } catch (error) {
        if (cache) return cache.guard;
        throw new Error("LegalWork's organization policy is unavailable. Retry after the LegalWork server reconnects.", { cause: error });
      } finally { pending = undefined; }
    })();
    return pending;
  };
  await ctx.permission.hook("evaluate", async event => {
    const guard = await readGuard();
    const connector = blockedConnector(guard, event.action);
    const effect = connector ? "deny" : required(guard, event.action, event.resources);
    if (STRICTNESS[effect] <= STRICTNESS[event.effect]) return;
    event.effect = effect;
    event.message = connector ? refusal(guard.orgName, 'the connector "' + connector + '"').message
      : effect === "deny" ? refusal(guard.orgName, "this " + event.action + " action").message
      : (guard.orgName ?? "Your organization") + " requires approval for this " + event.action + " action.";
  });
  await ctx.tool.hook("execute.before", async event => {
    const guard = await readGuard(), connector = blockedConnector(guard, event.tool);
    if (connector) throw refusal(guard.orgName, 'the connector "' + connector + '"');
  });
  await ctx.session.hook("model.request", async event => {
    const guard = await readGuard();
    if (guard.allowedProviders && !guard.allowedProviders.includes(event.model.providerID)) throw refusal(guard.orgName, 'the AI provider "' + event.model.providerID + '"');
  });
} });
export default LegalWorkOrgPolicyGuard;
