import { ApiError } from "../errors.js";
import { z } from "zod";
import { managedTools, managedToolName, managedNetworkGuard } from "./engine-policy.js";

function enginePath(path: string): string {
  const canonical = new URL(path, "http://engine.invalid").pathname;
  try {
    const decoded = decodeURIComponent(canonical).replace(/^\/opencode(?=\/|$)/, "").replace(/\/+$/, "");
    if (/\\|\/\/{1,}|(?:^|\/)\.{1,2}(?:\/|$)|%/i.test(decoded)) throw new Error("Ambiguous path");
    return decoded;
  } catch { throw new ApiError(400, "invalid_path", "Invalid engine path."); }
}

export function assertSandboxProxyAllowed(method: string, path: string): void {
  const decoded = enginePath(path);
  if (/^\/(?:v2\/)?pty(?:\/|$)/.test(decoded) || /^\/session\/[^/]+\/shell$/.test(decoded)) {
    throw new ApiError(403, "sandbox_required", "Use the sandboxed shell tool. Direct engine terminals are disabled.");
  }
  if (!["GET", "HEAD"].includes(method.toUpperCase()) &&
      (/^\/(?:global\/|v2\/)?config(?:\/|$)/.test(decoded) || decoded === "/mcp")) {
    throw new ApiError(403, "sandbox_policy_owned", "Change settings and connected apps through LegalWork.");
  }
}

/** Session rules are applied after agent rules by the engine. Keep the host
 * shell denied even if the sandbox plugin is unavailable during a reload. */
export function sandboxSessionBody(path: string, body: ArrayBuffer | undefined): ArrayBuffer | undefined {
  if (!body || !/^\/session(?:\/|$)/.test(enginePath(path))) return body;
  const value = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(body).toString()));
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

export function assertNoHostShellInterpolation(value: string): void {
  // OpenCode expands these BEFORE command.execute.before or shell.env hooks.
  if (/!`/.test(value)) throw new ApiError(403, "sandbox_required", "Shell interpolation in shortcuts is disabled. Run the command with the sandboxed shell tool.");
}
