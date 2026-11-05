import { expect, test } from "bun:test";
import { nativeMcpBinary, nativeMcpEngine, nativeOAuthProvider } from "./native-mcp-engine.test-support.js";
import { beginNativeMcpOAuth, nativeMcpOAuthStatus, waitForNativeMcpOAuth } from "./native-mcp.test-support.js";

test.skipIf(!nativeMcpBinary)("native OAuth requests the configured narrow scope despite broader advertised and registered defaults", async () => {
  const provider = await nativeOAuthProvider();
  const engine = await nativeMcpEngine({ mcp: { servers: { fixture: { type: "remote", url: `${provider.url}/mcp`, oauth: { scope: "mcp:read" } } } } });
  try {
    const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "fixture");
    expect(new URL(attempt.url).searchParams.get("scope")).toBe("mcp:read");
    await client.integration.oauth.cancel({ location: engine.location, integrationID: attempt.integrationID, attemptID: attempt.attemptID });
  } finally { await engine.close(); await provider.close(); }
}, 30_000);

test.skipIf(!nativeMcpBinary)("native empty scope uses broader provider defaults and cannot preserve an empty default override", async () => {
  const provider = await nativeOAuthProvider();
  const engine = await nativeMcpEngine({ mcp: { servers: { fixture: { type: "remote", url: `${provider.url}/mcp`, oauth: { scope: "" } } } } });
  try {
    const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "fixture");
    expect(new URL(attempt.url).searchParams.get("scope")).toBe("mcp:read mcp:write");
    await client.integration.oauth.cancel({ location: engine.location, integrationID: attempt.integrationID, attemptID: attempt.attemptID });
  } finally { await engine.close(); await provider.close(); }
}, 30_000);

test.skipIf(!nativeMcpBinary)("native MCP code completion does not replace its bound automatic callback", async () => {
  const provider = await nativeOAuthProvider();
  const engine = await nativeMcpEngine({ mcp: { servers: { fixture: { type: "remote", url: `${provider.url}/mcp` } } } });
  try {
    const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "fixture");
    expect(attempt.mode).toBe("auto");
    const authorized = await fetch(attempt.url, { redirect: "manual" });
    const callback = authorized.headers.get("location");
    if (!callback) throw new Error("Provider did not return its callback");
    const code = new URL(callback).searchParams.get("code");
    if (!code) throw new Error("Provider did not return its code");
    await expect(client.integration.oauth.complete({ integrationID: attempt.integrationID, attemptID: attempt.attemptID, location: engine.location, code })).rejects.toBeDefined();
    expect((await nativeMcpOAuthStatus(client, engine.location, attempt)).status).toBe("pending");
    expect((await fetch(callback)).ok).toBe(true);
    expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
  } finally { await engine.close(); await provider.close(); }
}, 30_000);
