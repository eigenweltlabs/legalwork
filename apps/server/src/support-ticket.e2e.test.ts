import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { closeEigenweltConnectionForTests, writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { EIGENWELT_BOOTSTRAP_PLATFORM_URL, EIGENWELT_DEPLOYMENTS } from "./native-shared-values.js";
import { startServer } from "./server.js";
import { readStartupSupport } from "./support-ticket.js";
import type { DesktopSupport, ServerConfig, WorkspaceInfo } from "./types.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./wiki/agent-access.js";

test("startup support checks the saved account without a running server or readable startup configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-startup-support-"));
  const configPath = join(root, "server.json");
  const config = {
    configPath, host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  } satisfies ServerConfig;
  const contact = { name: "Sample Support", phone: "+4930123456", email: "support@example.test",
    calendarUrl: "https://example.test/book", endsAt: new Date(Date.now() + 60_000).toISOString() };
  let responseStatus = 200;
  let onDuty = true;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`${EIGENWELT_BOOTSTRAP_PLATFORM_URL}/api/desktop/support/contact`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer startup-token");
    return Response.json({ contact: onDuty ? contact : null }, { status: responseStatus });
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await writeFile(configPath, "{invalid JSON");
    expect(await readStartupSupport(configPath, false)).toEqual({ authenticated: false, contact: null });
    expect(await readStartupSupport(configPath, true)).toEqual({ authenticated: false, contact: null });
    await writeEigenweltConnection(config, {
      account: { userId: "example_user", userName: null, userEmail: "user@example.test", orgId: "example_org", orgName: "Sample" },
      platformToken: "startup-token", platformURL: EIGENWELT_BOOTSTRAP_PLATFORM_URL, accessTokenExpiresAt: Date.now() + 600_000,
    });
    expect(await readStartupSupport(configPath, false)).toEqual({ authenticated: true, contact: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readStartupSupport(configPath, true)).toEqual({ authenticated: true, contact });
    onDuty = false;
    expect(await readStartupSupport(configPath, true)).toEqual({ authenticated: true, contact: null });
    responseStatus = 503;
    expect(await readStartupSupport(configPath, true)).toEqual({ authenticated: true, contact: null, unavailable: true });
    responseStatus = 401;
    expect(await readStartupSupport(configPath, true)).toEqual({ authenticated: false, contact: null });
  } finally {
    fetchMock.mockRestore();
    await closeEigenweltConnectionForTests(config);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["shared", EIGENWELT_BOOTSTRAP_PLATFORM_URL],
  ["EU", EIGENWELT_DEPLOYMENTS.eu.platform],
  ["US", EIGENWELT_DEPLOYMENTS.us.platform],
])("%s support sends each confirmed report only to the account's Platform", async (_, platform) => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-chat-support-"));
  const sessionId = "ses_support";
  const workspace: WorkspaceInfo = { id: "ws_support", name: "Support", path: root, workspaceType: "local", preset: "starter" };
  let choice: Awaited<ReturnType<DesktopSupport["confirm"]>> = "cancel";
  const detailedExport = (days: number) => JSON.stringify({ format: "legalwork-technical-diagnostics", schemaVersion: 2, scope: { days }, events: ["Synthetic entry"] });
  const logCollections: number[] = [];
  let platformUnavailable = false;
  const requests: { authorization: string | null; report: unknown }[] = [];
  const config: ServerConfig = {
    configPath: join(root, "server.json"), host: "127.0.0.1", port: 0,
    token: "support-client", hostToken: "support-host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], workspaces: [workspace], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
    desktopSupport: {
      confirm: async () => choice,
      collectLogs: async days => { logCollections.push(days); return detailedExport(days); },
      readChatLog: () => [],
    },
  };
  const server = await startServer(config);
  const originalFetch = globalThis.fetch;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const destination = new URL(String(input));
    if (destination.pathname === "/api/desktop/support/contact") {
      expect(destination.origin).toBe(platform);
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-support");
      return Response.json({ contact: { name: "On-call tester", phone: "+4930123456", email: "support@example.test",
        calendarUrl: "https://example.test/book", endsAt: "2029-11-27T15:00:00.000Z", ignored: "private" } });
    }
    if (destination.pathname !== "/api/desktop/support") return originalFetch(input, init);
    expect(destination.origin).toBe(platform);
    const report = JSON.parse(String(init?.body));
    const attachedLogs = typeof report.detailedLogs === "string";
    if (attachedLogs) report.detailedLogs = gunzipSync(Buffer.from(report.detailedLogs, "base64")).toString("utf8");
    requests.push({ authorization: new Headers(init?.headers).get("authorization"), report });
    if (platformUnavailable) throw new Error("Connection closed without confirmation");
    return Response.json({ ticketId: "SUP-42", attachedLogs }, { status: 201 });
  }, { preconnect: originalFetch.preconnect }));
  try {
    const url = `http://127.0.0.1:${server.port}/agent/support/ticket`;
    const contactURL = `http://127.0.0.1:${server.port}/support/contact`;
    const fetchContact = () => fetch(contactURL, { headers: { "X-LegalWork-Host-Token": config.hostToken } });
    expect((await fetch(contactURL, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(401);
    expect((await fetchContact()).status).toBe(401);
    const agentHeaders = {
      "X-LegalWork-Wiki-Agent-Token": await ensureWikiAgentToken(config),
      "X-LegalWork-Wiki-Agent-Session": sessionId,
      "X-LegalWork-Wiki-Agent-Directory": encodeURIComponent(root),
    };
    await grantWikiAgentSession(config, { sessionId, workspaceId: workspace.id, directory: root, scope: "owner" });
    const report = { description: "The model could not read a PDF." };
    const submit = (body: unknown = report) => fetch(url, { method: "POST", headers: agentHeaders, body: JSON.stringify(body) });
    expect((await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(403);
    expect(await (await fetch(url, { headers: agentHeaders })).json()).toEqual({ available: false });
    expect((await submit()).status).toBe(401);
    expect(requests).toHaveLength(0);

    await writeEigenweltConnection(config, {
      account: { userId: "user_support", userName: null, userEmail: "tester@example.test", orgId: "org_support", orgName: "Support Test" },
      platformToken: "access-support", platformURL: platform,
      accessTokenExpiresAt: Date.now() + 600_000,
    });
    expect(await (await fetch(url, { headers: agentHeaders })).json()).toEqual({ available: true });
    const supportContact = await fetchContact();
    expect(supportContact.headers.get("Cache-Control")).toBe("no-store");
    expect(await supportContact.json()).toEqual({ contact: { name: "On-call tester", phone: "+4930123456",
      email: "support@example.test", calendarUrl: "https://example.test/book", endsAt: "2029-11-27T15:00:00.000Z" } });
    expect((await submit({ ...report, logs: "invented by the model" })).status).toBe(400);
    expect(await (await submit()).json()).toEqual({ submitted: false, reason: "cancelled" });
    expect(requests).toHaveLength(0);
    expect(logCollections).toHaveLength(0);

    choice = "without_logs";
    expect(await (await submit()).json()).toEqual({ submitted: true, attachedLogs: false });
    expect(requests[0]).toEqual({ authorization: "Bearer access-support", report });
    expect(logCollections).toHaveLength(0);

    choice = "with_logs";
    expect(await (await submit()).json()).toEqual({ submitted: true, attachedLogs: true });
    expect(requests[1]).toEqual({ authorization: "Bearer access-support", report: { ...report, detailedLogs: detailedExport(2) } });
    expect(await (await submit({ ...report, logDays: 7 })).json()).toEqual({ submitted: true, attachedLogs: true });
    expect(requests[2]).toEqual({ authorization: "Bearer access-support", report: { ...report, detailedLogs: detailedExport(7) } });
    expect(logCollections).toEqual([2, 7]);
    expect(requests).toHaveLength(3);

    choice = "without_logs";
    platformUnavailable = true;
    const failed = await submit();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "support_delivery_unknown" });
    expect(requests).toHaveLength(4);
  } finally {
    fetchMock.mockRestore();
    await server.stop();
    await closeEigenweltConnectionForTests(config);
    await rm(root, { recursive: true, force: true });
  }
});
