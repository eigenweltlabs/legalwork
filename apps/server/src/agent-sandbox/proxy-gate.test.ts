import { expect, test } from "bun:test";
import { assertNoHostShellInterpolation, assertSandboxProxyAllowed, sandboxSessionBody } from "./proxy-gate.js";

test.each(["/pty", "/pty/terminal", "/opencode/pty/terminal/connect", "/session/s1/shell", "/session/s1/%73hell", "/v2/pty", "/config", "/global/config", "/mcp"])("blocks direct engine execution/config route %s", (path) => {
  expect(() => assertSandboxProxyAllowed("POST", path)).toThrow();
});
test("ordinary prompts and permission replies still pass", () => {
  expect(() => assertSandboxProxyAllowed("POST", "/session/s1/prompt_async")).not.toThrow();
  expect(() => assertSandboxProxyAllowed("POST", "/permission/p1/reply")).not.toThrow();
  expect(() => assertSandboxProxyAllowed("GET", "/config")).not.toThrow();
});
test("shortcut arguments cannot inject an early host command", () => {
  expect(() => assertNoHostShellInterpolation("Summarize !`python /tmp/script.py`")).toThrow();
  expect(() => assertNoHostShellInterpolation("Summarize this document")).not.toThrow();
});


test("session rules and legacy tool switches cannot enable host execution", () => {
  const body = new TextEncoder().encode(JSON.stringify({ tools: { "*": true, bash: true }, permission: [{ permission: "*", pattern: "*", action: "allow" }] })).buffer;
  const protectedBody = sandboxSessionBody("/session/s1/message", body);
  expect(protectedBody).toBeDefined();
  const decoded = JSON.parse(new TextDecoder().decode(protectedBody));
  expect(decoded.tools).toEqual({ "*": true, legalwork_shell: true, bash: false, webfetch: false, websearch: false });
  for (const permission of ["bash", "webfetch", "websearch"]) expect(decoded.permission).toContainEqual({ permission, pattern: "*", action: "deny" });
});
