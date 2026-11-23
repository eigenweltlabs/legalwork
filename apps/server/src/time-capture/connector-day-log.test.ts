import { workdayChatReader } from "./workday-chat.test-support.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { captureStateSchema, type CaptureAction } from "@legalwork/types/time-capture";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { recordConnectorActivation } from "../connectors/settings.js";
import { prepareConnectorStorage, writeConnectorConnections } from "../connectors/store.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { bootstrapRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { startServer } from "../server.js";
import { workdayEvidenceSchema } from "./private-workday.js";
import { captureProfile, checkScheduledWorkday } from "./routes.js";

test("manual and scheduled workday collection uses the actual authorized mail/calendar adapters and isolates a rate-limited account", async () => {
  const root = await mkdtemp(join(tmpdir(), "workday-connectors-"));
  const config = backOfficeTestConfig(root);
  const prior = new Map(["EIGENWELT_PLATFORM_URL", "LEGALWORK_RUNTIME_DB", "LEGALWORK_TOKEN_STORE"].map(key => [key, process.env[key]]));
  const nativeFetch = globalThis.fetch;
  const broker = "https://workday-connectors.test";
  const google = "worker@google.example", microsoft = "worker@microsoft.example", unrelated = "someone@other.example";
  const date = "2020-02-04", now = new Date(2020, 1, 4, 11).getTime(), at = new Date(2020, 1, 4, 9).toISOString(),
    end = new Date(2020, 1, 4, 10).toISOString();
  let googleTitle = "GCal appointment", rateLimited = false;
  const calls: URL[] = [];
  const fullEvent = { start: { dateTime: at }, end: { dateTime: end } };
  const googleEvent = (id: string, title: string) => ({ ...fullEvent, id, summary: title, iCalUID: id + "@example.test" });
  const graphEvent = (id: string, title: string) => ({ ...fullEvent, id, subject: title, iCalUId: id + "@example.test" });
  const graphMail = (id: string, subject: string, parentFolderId: string, sender: string) => ({
    id, subject, parentFolderId, sender: { emailAddress: { address: sender } }, isDraft: false, sentDateTime: at, receivedDateTime: at,
    conversationId: "private-graph-thread", internetMessageId: "<" + id + "@example.test>",
  });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    process.env.EIGENWELT_PLATFORM_URL = broker;
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
    await bootstrapRuntimeOpencodeConfig(config);
    await prepareConnectorStorage(config);
    await writeEigenweltConnection(config, { platformURL: broker, platformToken: "synthetic", account: {
      userId: "worker", userName: "Worker", userEmail: null, orgId: "firm", orgName: "Fixture firm" } });
    const owner = JSON.stringify([broker, "firm", "worker"]);
    for (const provider of ["gmail", "google-calendar", "outlook"])
      await writeConnectorConnections(config, owner, provider, [{ id: provider + "-account", nangoConnectionId: provider + "-private", createdAt: null, needsReconnect: false }]);
    for (const provider of ["outlook", "outlook-calendar"]) await recordConnectorActivation(config, provider, "outlook-account", true);
    const profile = await captureProfile(config, await backOfficeAccess(config));
    await mkdir(dirname(profile.path), { recursive: true });
    await writeFile(profile.path, JSON.stringify({ days: {}, lastRun: 0, settings: { calendar: false, tasks: false, documents: false,
      workspaceActivity: false, schedule: { frequency: "hourly" }, model: { workspaceId: "local", providerID: "local", modelID: "llama.cpp" } } }));
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
      calls.push(url);
      if (url.origin === broker) {
        if (url.pathname.endsWith("/token")) return Response.json({ accessToken: "provider-fixture", expiresAt: null });
        if (url.pathname.endsWith("/connection/status")) return Response.json({ connection: {
          id: JSON.parse(String(init?.body)).connectionId, createdAt: null, needsReconnect: false } });
      }
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer provider-fixture");
      const path = url.pathname;
      if (url.hostname === "gmail.googleapis.com") {
        if (path.endsWith("/profile")) return Response.json({ emailAddress: google });
        if (path.endsWith("/messages")) return Response.json(url.searchParams.get("pageToken") ? { messages: [{ id: "g-send" }] } :
          { messages: [{ id: "g-in" }, { id: "g-draft" }], nextPageToken: "page2" });
        const id = path.split("/").pop();
        expect(url.searchParams.get("format")).toBe("metadata");
        return Response.json({ internalDate: String(Date.parse(at)), threadId: "private-gmail-thread",
          labelIds: id === "g-send" ? ["SENT"] : id === "g-in" ? ["INBOX"] : ["DRAFT"],
          payload: { headers: [{ name: "Subject", value: id }, { name: "Message-ID", value: "<" + id + "@example.test>" }] } });
      }
      if (url.hostname === "www.googleapis.com") {
        if (path.endsWith("/calendarList")) return Response.json({ items: [{ id: google, primary: true, accessRole: "owner" },
          { id: "second", accessRole: "owner" }, { id: "shared", accessRole: "reader" }, { id: "revoked", accessRole: "reader" }] });
        if (path.includes("/revoked/")) return new Response(null, { status: 403 });
        if (path.includes("/shared/")) return Response.json({ items: [
          { ...googleEvent("shared", "GCal invited"), attendees: [{ email: google, responseStatus: "accepted" }] },
          { ...googleEvent("declined", "declined"), attendees: [{ email: google, responseStatus: "declined" }] },
          { ...googleEvent("other", "other agenda"), organizer: { email: unrelated } }] });
        if (path.includes("/second/")) return Response.json({ items: [googleEvent("secondary", "GCal owned secondary")] });
        if (path.includes("/primary/")) return Response.json({ items: [googleEvent("one", googleTitle), { id: "cancelled", status: "cancelled" }] });
      }
      if (url.hostname === "graph.microsoft.com") {
        if (path === "/v1.0/me") return Response.json({ mail: microsoft, userPrincipalName: microsoft });
        if (path.includes("/mailFolders/")) return Response.json({ id: path.split("/").pop() });
        if (path === "/v1.0/me/messages") {
          if (rateLimited) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
          if (url.searchParams.has("$skiptoken")) return Response.json({ value: [graphMail("m-in", "Outlook received", "archive", unrelated)] });
          return Response.json({ value: [graphMail("m-sent", "Outlook sent", "custom", microsoft), graphMail("junk", "Spam", "junkemail", unrelated)],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2" });
        }
        if (path.endsWith("/calendars")) return Response.json({ value: [{ id: "default", isDefaultCalendar: true, owner: { address: microsoft } },
          { id: "secondary", owner: { address: microsoft } }, { id: "shared", owner: { address: unrelated } }] });
        if (path.includes("/shared/")) return Response.json({ value: [{ ...graphEvent("mine", "Outlook invited"),
          attendees: [{ emailAddress: { address: microsoft }, status: { response: "accepted" } }] },
          { ...graphEvent("other", "other agenda"), organizer: { emailAddress: { address: unrelated } } }] });
        if (path.endsWith("/calendarView")) return Response.json({ value: [
          graphEvent(path.includes("/secondary/") ? "ms-two" : "ms-one", path.includes("/secondary/") ? "Outlook owned secondary" : "Outlook appointment"),
          { id: "declined", responseStatus: { response: "declined" } }] });
      }
      throw Error("Unexpected synthetic provider path " + path);
    }, { preconnect: nativeFetch.preconnect });
    server = await startServer(config);
    const query = new URLSearchParams({ date, profileId: profile.profileId, scope: profile.scope, principal: profile.principal, user: profile.user });
    const run = async (action?: CaptureAction) => {
      const response = await fetch("http://127.0.0.1:" + server!.port + "/private-timesheet/workday?" + query, {
        method: action ? "POST" : "GET", headers: { authorization: "Bearer fixture", "x-legalwork-host-token": "host", "content-type": "application/json" },
        body: JSON.stringify(action) });
      const value = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return captureStateSchema.parse(value);
    };
    const snapshot = z.object({ observations: z.array(workdayEvidenceSchema), failedAccounts: z.array(z.object({ provider: z.string(), reason: z.string() })),
      superseded: z.array(z.object({ observation: workdayEvidenceSchema })) });
    const log = async () => snapshot.parse(JSON.parse(await readFile(join(profile.path + ".day-log", date + ".json"), "utf8")));
    const readDay = await workdayChatReader(config, profile.profileId, server.port);
    await readDay(date);
    const initial = await run();
    expect(initial.connections.map(({ provider, name }) => [provider, name]).sort()).toEqual([
      ["gmail", google], ["google-calendar", google], ["outlook", microsoft], ["outlook-calendar", microsoft] ].sort());
    const first = await log();
    expect(first.failedAccounts).toEqual([]);
    expect(first.observations.map(row => row.proposal.narrative).sort()).toEqual([
      "g-send", "g-in", "Outlook sent", "Outlook received", "GCal appointment", "GCal owned secondary", "GCal invited",
      "Outlook appointment", "Outlook owned secondary", "Outlook invited" ].sort());
    for (const provider of ["gmail", "outlook"]) {
      const messages = first.observations.map(row => row.proposal).filter(row => row.source === provider);
      expect(messages.map(row => row.mailDirection).sort()).toEqual(["received", "sent"]);
      expect(messages[0].threadKey).toBe(messages[1].threadKey);
      expect(messages[0].threadKey).toHaveLength(64);
      for (const row of messages) expect(row).toMatchObject({ observedAt: at, startAt: null, endAt: null, workedMinutes: null });
    }
    expect(JSON.stringify(first)).not.toMatch(/private-gmail-thread|private-graph-thread|someone@other|worker@google/);
    const gmail = initial.connections.find(row => row.provider === "gmail")!;
    await run({ type: "settings-patch", change: { field: "account", account: gmail, value: false } });
    calls.length = 0;
    googleTitle = "Revised calendar title";
    rateLimited = true;
    await checkScheduledWorkday(config, { now: () => now });
    expect(calls.some(url => url.hostname === "gmail.googleapis.com")).toBe(false);
    const partial = await log();
    expect(partial.failedAccounts).toMatchObject([{ provider: "outlook", reason: "connector_api_rate_limited" }]);
    expect(partial.observations.some(row => row.proposal.narrative === googleTitle)).toBe(true);
    expect(partial.observations.some(row => row.proposal.source === "gmail")).toBe(false);
    expect(partial.observations.filter(row => row.proposal.source === "outlook")).toHaveLength(2);
    expect((await run()).status?.message).toContain(microsoft);
    rateLimited = false;
    await readDay(date);
    expect((await log()).failedAccounts).toEqual([]);
  } finally {
    await server?.stop();
    globalThis.fetch = nativeFetch;
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
