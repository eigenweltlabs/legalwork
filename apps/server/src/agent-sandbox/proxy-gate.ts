import { nativeProxyPath } from "../native-proxy-policy.js";
import { ApiError } from "../errors.js";
import { z } from "zod";
import { managedTools, managedToolName, managedNetworkGuard } from "./engine-policy.js";

const enginePath = nativeProxyPath;

export function assertSandboxProxyAllowed(method: string, path: string): void {
  const decoded = enginePath(path);
  if (/^\/(?:v2\/)?pty(?:\/|$)/.test(decoded) || /^\/session\/[^/]+\/shell$/.test(decoded) || decoded === "/shell" && method.toUpperCase() === "POST") {
    throw new ApiError(403, "sandbox_required", "Use the sandboxed shell tool. Direct engine terminals are disabled.");
  }
  if (!["GET", "HEAD"].includes(method.toUpperCase()) &&
      (/^\/(?:global\/|v2\/)?config(?:\/|$)/.test(decoded) || decoded === "/experimental/config" || decoded === "/websearch" || decoded === "/mcp")) {
    throw new ApiError(403, "sandbox_policy_owned", "Change settings and connected apps through LegalWork.");
  }
}

/** Session rules are applied after agent rules by the engine. Keep the host
 * shell denied even if the sandbox plugin is unavailable during a reload. */
export function sandboxSessionBody(path: string, body: ArrayBuffer | undefined): ArrayBuffer | undefined {
  if (!body || !/^\/session(?:\/|$)/.test(enginePath(path))) return body;
  const value = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(body).toString()));
  if (value.permissions !== undefined) {
    const rules = z.array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "ask", "deny"]) })).parse(value.permissions);
    const nativeTools: Record<string, string> = { shell: "legalwork_shell", webfetch: "legalwork_webfetch", websearch: "legalwork_websearch", codesearch: "legalwork_websearch" };
    value.permissions = [
      ...rules.map(rule => ({ ...rule, action: nativeTools[rule.action] ?? rule.action })),
      ...Object.keys(nativeTools).map(action => ({ action, resource: "*", effect: "deny" })),
      { action: managedNetworkGuard, resource: "*", effect: "deny" },
    ];
  }
  if (value.tools !== undefined) {
    const tools = z.record(z.string(), z.boolean()).parse(value.tools);
    for (const [builtin, managed] of Object.entries(managedTools)) {
      if (tools[builtin] !== undefined) tools[managed] = tools[builtin];
      tools[builtin] = false;
    }
    value.tools = tools;
  }
  if (value.permission !== undefined) {
    const rules = z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"]) })).parse(value.permission);
    value.permission = [...rules.map((rule) => ({ ...rule, permission: managedToolName(rule.permission) })),
      ...Object.keys(managedTools).map(permission => ({ permission, pattern: "*", action: "deny" })), { permission: managedNetworkGuard, pattern: "*", action: "deny" }];
  }
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}
