import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CaptureAccount } from "@legalwork/types/time-capture";
import type { ConnectorRequest } from "../connectors/request.js";
import { fileWorkdayEvidence } from "./file-workday.js";
import { saveWorkdayLog } from "./day-log.js";
import { personalDriveChanges } from "./file-workday.js";
import { observedPersonalDrive } from "./personal-drive-workday.js";
import { currentActivityProfile } from "./activity-workday.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { digest } from "./private-workday.js";
import { prepareConnectorStorage, writeConnectorConnections } from "../connectors/store.js";
import { eigenweltPlatformUrl } from "../eigenwelt-endpoints.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";

const date = "2026-11-22", zone = "Europe/Berlin", time = "2026-11-22T10:01:03.000Z";
const account = (provider: CaptureAccount["provider"]) => ({ provider, account: "f".repeat(64) });

test("Google Drive, OneDrive and SharePoint write attributable point events to the private day log", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-workday-"));
  const profile = join(root, "worker");
  const names: string[] = [];
  const google: ConnectorRequest = async path => {
    if (path.startsWith("/drive/v3/about")) return { user: { emailAddress: "worker@example.test" } };
    const url = new URL(path, "https://www.googleapis.com");
    expect(url.pathname).toBe("/drive/v3/files");
    expect(url.searchParams.get("fields")).not.toContain("owners");
    if (url.searchParams.has("pageToken")) return { files: [
      { id: "expired", name: "Previous day", mimeType: "text/plain", modifiedByMeTime: "2026-11-21T22:59:59Z" },
    ] };
    return { nextPageToken: "next", files: [
      { id: "1", name: "Lease review", mimeType: "application/vnd.google-apps.document", modifiedByMeTime: time },
      { id: "2", name: "Owned or opened only", mimeType: "application/pdf" },
      { id: "3", name: "Folder", mimeType: "application/vnd.google-apps.folder", modifiedByMeTime: time },
    ] };
  };
  const site = "https://tenant.sharepoint.com/sites/legal/";
  const make = (id: string, driveId: string, modifiedBy: string, webUrl = site, extras = {}) => ({
    id, name: id, parentReference: { driveId }, file: {}, lastModifiedBy: { user: { id: modifiedBy } },
    lastModifiedDateTime: time, webUrl, ...extras,
  });
  const graph: ConnectorRequest = async (path, options) => {
    if (path.startsWith("/v1.0/me/drive?")) return { id: "mine", owner: { user: { id: "worker", displayName: "Synthetic Worker" } } };
    if (path.startsWith("/v1.0/drives/lib/items/project")) return make("project", "lib", "worker");
    expect(path).toBe("/v1.0/search/query");
    expect(options?.method).toBe("POST");
    return { value: [{ hitsContainers: [{ hits: [
      make("my-draft", "mine", "worker", "https://tenant-my.sharepoint.com/personal/worker"),
      make("project", "lib", "worker", site, { lastModifiedBy: { user: { displayName: "Unverified display" } } }),
      make("someone-else", "lib", "colleague"), make("remote-private", "other", "worker", "https://tenant-my.sharepoint.com/personal/other"),
      make("application", "lib", "worker", site, { lastModifiedBy: { application: { id: "sync" }, user: { id: "worker" } } }),
      make("old", "lib", "worker", site, { lastModifiedDateTime: "2026-11-15T12:00:00Z" }),
    ].map(resource => ({ resource })) }] }] };
  };
  const signal = new AbortController().signal;
  try {
    const rows = (await Promise.all([
      fileWorkdayEvidence(account("google-drive"), date, zone, google, signal, name => names.push(name)),
      fileWorkdayEvidence(account("onedrive"), date, zone, graph, signal, name => names.push(name)),
      fileWorkdayEvidence(account("sharepoint-files"), date, zone, graph, signal, name => names.push(name)),
    ])).flat();
    expect(rows.map(row => row.proposal.narrative)).toEqual(["Lease review", "my-draft", "project"]);
    expect(names.sort()).toEqual(["Synthetic Worker", "Synthetic Worker", "worker@example.test"]);
    await saveWorkdayLog(profile, date, zone, time, rows);
    await saveWorkdayLog(profile, date, zone, time, rows);
    const saved = JSON.parse(await readFile(join(profile + ".day-log", date + ".json"), "utf8"));
    expect(saved.observations).toHaveLength(3);
    expect(saved.superseded).toEqual([]);
    expect(saved.observations.every((row: { proposal: { workedMinutes: number | null; observedAt: string; startAt: string | null } }) =>
      row.proposal.workedMinutes === null && row.proposal.startAt === null && row.proposal.observedAt === time)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("connected personal drive saves attributed changes and starts fresh after Time tracking is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "personal-drive-workday-"));
  const config = backOfficeTestConfig(root);
  const provider = "onedrive-personal", id = "fixture-drive", broker = eigenweltPlatformUrl();
  const source = { provider, account: digest([provider, id]) } satisfies CaptureAccount;
  const signal = new AbortController().signal;
  await prepareConnectorStorage(config);
  await writeEigenweltConnection(config, { platformURL: broker, platformToken: "fixture",
    account: { userId: "worker", userName: "Worker", userEmail: null, orgId: "firm", orgName: "Firm" } });
  const owner = JSON.stringify([broker, "firm", "worker"]);
  await writeConnectorConnections(config, owner, provider, [{ id, nangoConnectionId: "private-drive", createdAt: null, needsReconnect: false }]);
  const profile = await currentActivityProfile(config);
  const writeConsent = async (epoch: number, enabled: boolean) => {
    await mkdir(dirname(profile.path), { recursive: true });
    await writeFile(profile.path, JSON.stringify({ lastRun: 0, days: {}, personalDriveEpoch: epoch,
      settings: { calendar: false, tasks: false, enabled } }));
  };
  const base = "https://graph.microsoft.com/v1.0/drives/d/root/delta?";
  let initialReads = 0, collected = false;
  const request: ConnectorRequest = async path => {
    if (path.startsWith("/v1.0/me/drive?")) return { id: "d", owner: { user: { id: "worker" } } };
    if (path.endsWith("token=latest")) {
      initialReads++;
      return { value: [], "@odata.deltaLink": base + "token=from-now" };
    }
    if (path.endsWith("token=from-now")) {
      collected = true;
      return { value: [], "@odata.nextLink": base + "token=page2" };
    }
    const modification = (id: string, user: string, at: string) => ({ id, file: {}, name: id, lastModifiedBy: { user: { id: user } }, lastModifiedDateTime: at });
    return { value: path.endsWith("token=page2") ? [
      modification("Me.docx", "worker", time), modification("Yesterday.docx", "worker", "2026-11-21T11:00:00Z"),
      modification("Colleague.docx", "else", time),
    ] : [], "@odata.deltaLink": base + "token=done" };
  };
  try {
    await writeConsent(1, true);
    expect(await observedPersonalDrive(config, source, date, zone, request, signal)).toEqual([]);
    expect(initialReads).toBe(1);
    const today = await observedPersonalDrive(config, source, date, zone, request, signal);
    expect(collected).toBe(true);
    expect(today.map(row => row.proposal.narrative)).toEqual(["Me.docx"]);
    const yesterday = await observedPersonalDrive(config, source, "2026-11-21", zone, request, signal);
    expect(yesterday.map(row => row.proposal.narrative)).toEqual(["Yesterday.docx"]);
    await saveWorkdayLog(profile.path, date, zone, time, today, [], [source]);
    expect(await readFile(join(profile.path + ".day-log", date + ".json"), "utf8")).not.toContain("Colleague");
    await writeConsent(2, false);
    await expect(observedPersonalDrive(config, source, date, zone, request, signal)).rejects.toThrow();
    await writeConsent(3, true);
    await observedPersonalDrive(config, source, date, zone, request, signal);
    expect(initialReads).toBe(2);
    await writeConnectorConnections(config, owner, provider, []);
    await expect(observedPersonalDrive(config, source, date, zone, request, signal)).rejects.toMatchObject({ code: "private_workday_changed" });
    const hostile: ConnectorRequest = async path => path.startsWith("/v1.0/me/drive?")
      ? { id: "d", owner: { user: { id: "worker" } } } : { value: [], "@odata.nextLink": "https://example.test/v1.0/drives/d/root/delta?token=x" };
    await expect(personalDriveChanges(source, undefined, zone, hostile, signal)).rejects.toThrow("invalid change cursor");
  } finally { await rm(root, { recursive: true, force: true }); }
});
