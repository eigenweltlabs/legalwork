import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { backOfficeStore } from "../back-office/store.js";
import { commandTimesheet } from "../back-office/timesheet.js";
import { readTimeDocument } from "../back-office/timesheet-data.js";
import { startServer } from "../server.js";
import ProjectPlugin from "../opencode-plugins/legalwork-project-tools.js";
import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
import { ensureWikiAgentToken } from "../wiki/agent-access.js";
import { captureProfile } from "./profile.js";
import { workdayChatClient } from "./workday-chat.test-support.js";

test("the private chat translates or removes saved records and workflow entries using the revision it read", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-chat-entries-"));
  const config = backOfficeTestConfig(root);
  const server = await startServer(config);
  const names = ["LEGALWORK_SERVER_URL", "LEGALWORK_SERVER_TOKEN", "LEGALWORK_WIKI_AGENT_TOKEN"];
  const previous = names.map(name => process.env[name]);
  let plugin: Awaited<ReturnType<typeof nativePluginTools>> | undefined;
  try {
    const access = await backOfficeAccess(config);
    const { actor, scope } = access;
    const { profileId } = await captureProfile(config, access);
    const chat = await workdayChatClient(config, profileId, server.port);
    process.env.LEGALWORK_SERVER_URL = "http://127.0.0.1:" + server.port;
    process.env.LEGALWORK_SERVER_TOKEN = config.token;
    process.env.LEGALWORK_WIKI_AGENT_TOKEN = await ensureWikiAgentToken(config);
    plugin = await nativePluginTools(ProjectPlugin, { directory: config.workspaces[0].path, sessionID: "workday-source-test" });
    const workday = plugin.tool.legalwork_timekeeping_workday;
    const store = await backOfficeStore(config);
    const client = store.saveRecord(scope, actor, { revision: 0, objectId: "clients", values: { name: "Example" } });
    const matter = store.saveRecord(scope, actor, { revision: 0, objectId: "matters", values: { name: "Lease", clients: [client.id] } });
    const date = "2025-10-13", list = () => chat({ date, action: "list_entries" });
    const original = "Reviewed the rent schedule.", translation = "Prüfung der Mietaufstellung.";
    const values = { name: original, billingNarrative: original, matter: matter.id, client: client.id, serviceDate: date,
      startedAt: date + "T10:00:00Z", endedAt: date + "T10:19:00Z", recordedMinutes: 19, billableMinutes: 20, status: "Draft" };
    const add = (narrative: string) => store.saveRecord(scope, actor, { revision: 0, objectId: "timeEntries",
      values: { ...values, name: narrative, billingNarrative: narrative } });
    const retained = add(original);
    const placeholders = Array.from({ length: 4 }, (_, i) => add("Placeholder " + i));
    const command = (input: unknown) => commandTimesheet(store, scope, actor, [{ id: actor.userId, name: "Timekeeper" }], input);
    const price = (revision: number, hourlyRate: number) => command({ type: "policy", policy: {
      scope: "firm", targetId: "firm", effectiveFrom: date, revision, hourlyRate, currency: "EUR", soloApproval: true,
    } });
    price(0, 150);
    const workflow = command({ type: "create", requestId: randomUUID(), entry: {
      date, clientId: client.id, matterId: matter.id, activity: "RES", narrative: original, workedMinutes: 19, billable: true, billableMinutes: 20,
    } }).entries.find(entry => !entry.legacy)!;
    expect(workflow.hourlyRate).toBe(150);
    price(1, 250);
    expect((await list()).entries).toHaveLength(6);
    const ref = { date, id: retained.id, revision: retained.revision };
    const translated = JSON.parse(await workday.execute({ action: "update_entry", ...ref, changes: { narrative: translation } }));
    expect(translated.revision).toBe(retained.revision + 1);
    expect(store.raw(scope, retained.id)?.values).toEqual({ ...retained.values, name: translation, billingNarrative: translation });
    await expect(chat({ action: "update_entry", ...ref, changes: { narrative: "Stale" } })).rejects.toThrow("(409)");
    await expect(chat({ action: "remove_entry", ...ref })).rejects.toThrow("(409)");
    for (const entry of placeholders) {
      expect(JSON.parse(await workday.execute({ action: "remove_entry", date, id: entry.id, revision: entry.revision }))).toMatchObject({ removed: true });
      expect(store.raw(scope, entry.id)?.archivedAt).toBeTruthy();
      expect(store.history(scope, actor, entry.id).length).toBeGreaterThan(1);
    }
    const update = { action: "update_entry", date, id: workflow.id, revision: workflow.revision, changes: { narrative: translation } };
    await expect(chat({ ...update, date: "2025-10-14" })).rejects.toThrow("(404)");
    const { revision } = await chat(update);
    await expect(chat({ ...update, action: "remove_entry", changes: undefined })).rejects.toThrow("(409)");
    expect((await list()).entries).toHaveLength(2);
    const history = readTimeDocument(store, scope, workflow.id);
    expect(history?.kind === "entry" && history.value.history.at(-1)).toMatchObject({
      actorId: actor.userId, agentId: "timekeeping",
      before: { narrative: original, workedMinutes: 19, hourlyRate: 150 },
      after: { narrative: translation, workedMinutes: 19, billableMinutes: 20, hourlyRate: 150 },
    });
    const nextRevision = (await chat({ action: "update_entry", date, id: workflow.id, revision, changes: { recordedMinutes: 22, billableMinutes: 30 } })).revision;
    await chat({ action: "remove_entry", date, id: workflow.id, revision: nextRevision });
    const withdrawn = readTimeDocument(store, scope, workflow.id);
    expect(withdrawn?.kind === "entry" && withdrawn.value).toMatchObject({ status: "declined", history: expect.arrayContaining([expect.objectContaining({ action: "withdraw" })]) });
    expect((await list()).entries).toMatchObject([{ id: retained.id, revision: translated.revision, narrative: translation }]);
    const lockedDate = "2025-10-14";
    const locked = command({ type: "create", requestId: randomUUID(), entry: { date: lockedDate, clientId: client.id,
      matterId: matter.id, activity: "RES", narrative: original, workedMinutes: 19, billable: true, billableMinutes: 20 } })
      .entries.find(entry => entry.date === lockedDate)!;
    command({ type: "submit", entries: [{ id: locked.id, revision: locked.revision }] });
    const [submitted] = (await chat({ date: lockedDate, action: "list_entries" })).entries;
    expect(submitted).toMatchObject({ status: "submitted", removable: false });
    await expect(chat({ date: lockedDate, action: "remove_entry", id: locked.id, revision: submitted.revision })).rejects.toThrow("(403)");
    command({ type: "approve", entries: [{ id: locked.id, revision: submitted.revision }] });
    const [approved] = (await chat({ date: lockedDate, action: "list_entries" })).entries;
    expect(approved).toMatchObject({ status: "approved", editable: false, removable: false });
    for (const action of ["remove_entry", "update_entry"]) {
      await expect(chat({ date: lockedDate, action, id: locked.id, revision: approved.revision,
        ...(action === "update_entry" ? { changes: { narrative: translation } } : {}) })).rejects.toThrow("(403)");
    }
  } finally {
    await plugin?.close();
    for (const [i, name] of names.entries()) {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
