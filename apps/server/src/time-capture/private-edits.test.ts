import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { captureSettingsSchema, captureStateSchema, type CaptureAction } from "../back-office/timesheet-schema.js";
import { startServer } from "../server.js";
import { captureProfile } from "./routes.js";

test("two workday windows preserve disjoint settings and draft edits, and detect changed or deleted drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-concurrent-workdays-"));
  const config = backOfficeTestConfig(root);
  const { path, profileId, scope, user, principal } = await captureProfile(config, await backOfficeAccess(config));
  const date = "2026-11-20", key = randomUUID();
  const legacySettings = captureSettingsSchema.parse({ calendar: true, tasks: true, documents: true, intervalMinutes: 0 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    settings: legacySettings, lastRun: 0, days: {},
    drafts: { [key]: { date, values: { billingNarrative: "Initial draft", recordedMinutes: 15 } } },
  }));
  const server = await startServer(config);
  const url = `http://127.0.0.1:${server.port}/private-timesheet/workday?` + new URLSearchParams({ date, profileId, scope, user, principal });
  function request(action?: CaptureAction) {
    return fetch(url, { method: action ? "POST" : "GET",
      body: action && JSON.stringify(action), headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" } });
  }
  async function read(action?: CaptureAction) {
    const response = await request(action);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return captureStateSchema.parse(body);
  }
  try {
    const [first, second] = await Promise.all([read(), read()]);
    const accountA = { provider: "gmail" as const, account: "a".repeat(64) };
    const accountB = { provider: "outlook" as const, account: "b".repeat(64) };
    await read({ type: "settings-patch", change: { field: "calendar", value: false } });
    await read({ type: "settings-patch", change: { field: "account", account: accountA, value: false } });
    await read({ type: "settings-patch", change: { field: "account", account: accountB, value: false } });
    const settings = (await read({ type: "settings-patch", change: { field: "intervalMinutes", value: 30 } })).settings;
    expect(settings).toMatchObject({ calendar: false, intervalMinutes: 30, disabledConnections: [accountA, accountB] });
    expect((await request({ type: "settings", settings: second.settings })).status).toBe(409);
    expect((await read()).settings).toEqual(settings);

    const edit: CaptureAction = { type: "draft-patch", key, date, revision: first.drafts[key].revision ?? 0, changes: { billingNarrative: "First window wording" } };
    const updated = (await read(edit)).drafts[key];
    const merged = (await read({ type: "draft-patch", key, date, revision: second.drafts[key].revision ?? 0, changes: { recordedMinutes: 30 } })).drafts[key];
    expect(merged.values).toEqual({ billingNarrative: "First window wording", recordedMinutes: 30 });
    expect(merged.revision).toBeGreaterThan(updated.revision ?? 0);
    // A lost response can be retried without undoing the other window's change.
    expect((await read(edit)).drafts[key]).toEqual(merged);
    const replaced = { ...edit, changes: { billingNarrative: "Second window wording" } };
    const sameField = await request(replaced);
    expect(sameField.status).toBe(409);
    expect(await sameField.json()).toMatchObject({ code: "private_draft_conflict", details: { draft: merged } });
    const resolved = (await read({ ...replaced, revision: merged.revision ?? 0 })).drafts[key];
    expect(resolved.values).toEqual({ billingNarrative: "Second window wording", recordedMinutes: 30 });
    expect((await request(edit)).status).toBe(409);
    expect((await request({ ...edit, changes: null })).status).toBe(409);
    const deletion = { ...edit, changes: null, revision: resolved.revision ?? 0 };
    expect((await read(deletion)).drafts[key]).toBeUndefined();
    expect((await read(deletion)).drafts[key]).toBeUndefined();
    expect((await request(edit)).status).toBe(409);
    expect((await request({ ...replaced, revision: resolved.revision ?? 0 })).status).toBe(409);
    expect((await read()).drafts[key]).toBeUndefined();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
