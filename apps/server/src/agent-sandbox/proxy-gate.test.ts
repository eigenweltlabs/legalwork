import { expect, test } from "bun:test";
import { assertSandboxProxyAllowed, sandboxSessionBody } from "./proxy-gate.js";
import { managedNetworkGuard, managedPermissionRules } from "./engine-policy.js";

test.each(["/pty", "/pty/terminal", "/opencode/pty/terminal/connect", "/session/s1/shell", "/session/s1/%73hell", "/v2/pty", "/config", "/global/config", "/mcp"])("blocks direct engine execution/config route %s", (path) => {
  expect(() => assertSandboxProxyAllowed("POST", path)).toThrow();
});
test("ordinary prompts and permission replies still pass", () => {
  expect(() => assertSandboxProxyAllowed("POST", "/session/s1/prompt_async")).not.toThrow();
  expect(() => assertSandboxProxyAllowed("POST", "/permission/p1/reply")).not.toThrow();
  expect(() => assertSandboxProxyAllowed("GET", "/config")).not.toThrow();
});
test("session rules and legacy tool switches cannot enable host execution", () => {
  const body = new TextEncoder().encode(JSON.stringify({ tools: { "*": true, bash: true }, permission: [{ permission: "*", pattern: "*", action: "allow" }] })).buffer;
  const protectedBody = sandboxSessionBody("/session/s1/message", body);
  expect(protectedBody).toBeDefined();
  const decoded = JSON.parse(new TextDecoder().decode(protectedBody));
  expect(decoded.tools).toEqual({ "*": true, legalwork_shell: true, bash: false, webfetch: false, websearch: false });
  for (const permission of ["bash", "webfetch", "websearch"]) expect(decoded.permission).toContainEqual({ permission, pattern: "*", action: "deny" });
});

test.each(["/api/session/s1/shell", "/opencode/api/session/s1/%73hell", "/api/shell", "/api/experimental/config", "/api/websearch"])("native API route %s cannot bypass the sandbox", path => {
  expect(() => assertSandboxProxyAllowed("POST", path)).toThrow();
});
test("native session permission overrides cannot re-enable host tools", () => {
  const body = new TextEncoder().encode(JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "allow" }] })).buffer;
  const result = JSON.parse(new TextDecoder().decode(sandboxSessionBody("/api/session/s1", body)));
  expect(result.permissions).toContainEqual({ action: "legalwork_shell", resource: "*", effect: "allow" });
  for (const action of ["shell", "webfetch", "websearch", "codesearch"]) expect(result.permissions).toContainEqual({ action, resource: "*", effect: "deny" });
});

test("native generated host denials do not block managed tools and explicit restrictions survive", () => {
  for (const effect of [undefined, "ask", "deny"]) {
    const body = new TextEncoder().encode(JSON.stringify({ permissions: [
      { action: "*", resource: "*", effect: "allow" },
      ...(effect ? [{ action: "shell", resource: "rm *", effect }] : []),
    ] })).buffer;
    const result = JSON.parse(new TextDecoder().decode(sandboxSessionBody("/api/session", body)));
    expect(result.permissions).toContainEqual({ action: managedNetworkGuard, resource: "*", effect: "deny" });
    expect(result.permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" });
    const session = result.permissions.map((rule: { action: string; resource: string; effect: string }) => ({
      permission: rule.action === "shell" ? "bash" : rule.action, pattern: rule.resource, action: rule.effect,
    }));
    expect(managedPermissionRules([{ permission: "*", pattern: "*", action: "allow" }], session)).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "*", pattern: "*", action: "allow" },
      ...(effect ? [{ permission: "bash", pattern: "rm *", action: effect }] : []),
      { permission: "codesearch", pattern: "*", action: "deny" },
    ]);
  }
});
