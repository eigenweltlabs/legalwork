import { z } from "zod";
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
    const billing = plugin.tool.legalwork_timekeeping_billing;
    const applyBilling = async (command: Record<string, unknown>) => JSON.parse(await billing.execute({ action: "apply", command }));
    const hostHeaders = { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" };
    const base = "http://127.0.0.1:" + server.port;
    const pendingSchema = z.object({ items: z.array(z.object({ id: z.string(), sessionID: z.string(), workspaceId: z.string(),
      action: z.string(), canRemember: z.boolean(), description: z.string() })) });
    const pending = async () => pendingSchema.parse(await (await fetch(base + "/approvals", { headers: hostHeaders })).json()).items;
    const withDecision = async <T>(operation: Promise<T>, reply: "allow" | "deny", before?: () => void, action = "timekeeping.entry.remove") => {
      void operation.catch(() => {});
      let requests = await pending();
      for (let attempt = 0; !requests.length && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        requests = await pending();
      }
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request).toMatchObject({ action, sessionID: "workday-source-test", workspaceId: "time-review", canRemember: false });
      expect(request.description).toContain(action === "timekeeping.entry.remove" ? "Recorded:" :
        action === "timekeeping.billing.policy" ? "Effective from" : "marks the selected time as invoiced");
      before?.();
      const body = { reply, sessionID: request.sessionID, workspaceId: request.workspaceId };
      // The agent cannot answer its own approval or create a permanent deletion grant.
      expect((await fetch(base + "/approvals/" + request.id, { method: "POST", headers: { Authorization: "Bearer " + config.token,
        "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
      expect((await fetch(base + "/approvals/" + request.id, { method: "POST", headers: hostHeaders,
        body: JSON.stringify({ ...body, reply: "always" }) })).status).toBe(404);
      expect((await fetch(base + "/approvals/" + request.id, { method: "POST", headers: hostHeaders, body: JSON.stringify(body) })).status).toBe(200);
      return operation;
    };
    const store = await backOfficeStore(config);
    const client = store.saveRecord(scope, actor, { revision: 0, objectId: "clients", values: { name: "Example", billingAddress: "1 Test Square" } });
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
    const removable = placeholders[0];
    const remove = () => workday.execute({ action: "remove_entry", date, id: removable.id, revision: removable.revision });
    await expect(withDecision(remove(), "deny", () => expect(store.raw(scope, removable.id)?.archivedAt).toBeNull())).rejects.toThrow("did not approve");
    expect(store.raw(scope, removable.id)?.archivedAt).toBeNull();
    // The generic archive tool must not bypass the chat confirmation.
    await expect(plugin.tool.legalwork_back_office_save.execute({ id: removable.id, objectId: "timeEntries", revision: removable.revision,
      values: {}, archived: true })).rejects.toThrow("requires user confirmation");
    const concurrent = add("Concurrent edit");
    await expect(withDecision(chat({ action: "remove_entry", date, id: concurrent.id, revision: concurrent.revision }), "allow", () => {
      store.saveRecord(scope, actor, { id: concurrent.id, objectId: "timeEntries", revision: concurrent.revision, values: { name: "Changed while pending" } });
    })).rejects.toThrow("(409)");
    expect(store.raw(scope, concurrent.id)?.archivedAt).toBeNull();
    await withDecision(chat({ action: "remove_entry", date, id: concurrent.id, revision: concurrent.revision + 1 }), "allow");
    const timedOut = add("Unanswered removal");
    await expect(chat({ action: "remove_entry", date, id: timedOut.id, revision: timedOut.revision })).rejects.toThrow("did not approve");
    expect(store.raw(scope, timedOut.id)?.archivedAt).toBeNull();
    expect(await pending()).toEqual([]);
    await withDecision(chat({ action: "remove_entry", date, id: timedOut.id, revision: timedOut.revision }), "allow");
    for (const entry of placeholders) {
      expect(JSON.parse(await withDecision(workday.execute({ action: "remove_entry", date, id: entry.id, revision: entry.revision }), "allow",
        () => expect(store.raw(scope, entry.id)?.archivedAt).toBeNull()))).toMatchObject({ removed: true });
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
    await withDecision(chat({ action: "remove_entry", date, id: workflow.id, revision: nextRevision }), "allow", () => {
      const pendingEntry = readTimeDocument(store, scope, workflow.id);
      expect(pendingEntry?.kind === "entry" && pendingEntry.value.status).not.toBe("declined");
    });
    expect(await pending()).toEqual([]);
    const withdrawn = readTimeDocument(store, scope, workflow.id);
    expect(withdrawn?.kind === "entry" && withdrawn.value).toMatchObject({ status: "declined", history: expect.arrayContaining([expect.objectContaining({ action: "withdraw" })]) });
    expect((await list()).entries).toMatchObject([{ id: retained.id, revision: translated.revision, narrative: translation }]);
    const lockedDate = "2025-10-14";
    const billingPolicy = { type: "policy", policy: { scope: "matter", targetId: matter.id,
      effectiveFrom: lockedDate, revision: 0, minimumMinutes: 10 } };
    await expect(withDecision(applyBilling(billingPolicy), "deny", undefined,
      "timekeeping.billing.policy")).rejects.toThrow("did not approve");
    const configured = await withDecision(applyBilling(billingPolicy), "allow", undefined, "timekeeping.billing.policy");
    expect(configured.policies).toContainEqual(expect.objectContaining({ targetId: matter.id, revision: 1, minimumMinutes: 10 }));
    const created = await applyBilling({ type: "create", requestId: randomUUID(), entry: { date: lockedDate, clientId: client.id,
      matterId: matter.id, activity: "RES", narrative: original, workedMinutes: 19, billable: true, billableMinutes: 20 } });
    const [locked] = JSON.parse(await billing.execute({ action: "read", from: lockedDate, to: lockedDate })).entries;
    expect(locked).toMatchObject({ status: "confirmed", requiresReview: false, revision: 1 });
    expect(created.entries).toContainEqual(expect.objectContaining({ id: locked.id }));
    const saved = await applyBilling({ type: "submit", entries: [{ id: locked.id, revision: locked.revision }] });
    expect(saved.entries).toContainEqual(expect.objectContaining({ id: locked.id, status: "confirmed", revision: locked.revision }));
    const createInvoice = { type: "createInvoice", requestId: randomUUID(), invoice: {
      matterId: matter.id, clientId: client.id, period: { from: lockedDate, to: lockedDate },
      entries: [{ id: locked.id, revision: locked.revision }], wording: [], adjustmentVersions: [], pricing: { mode: "hourly" },
    } };
    await expect(applyBilling({ type: "prepareInvoice", draft: createInvoice.invoice }))
      .rejects.toThrow();
    await expect(withDecision(applyBilling(createInvoice), "deny", undefined, "timekeeping.billing.createInvoice")).rejects.toThrow("did not approve");
    const savedInvoice = await withDecision(applyBilling(createInvoice), "allow", undefined, "timekeeping.billing.createInvoice");
    const invoice = savedInvoice.invoices.find((row: { number: number }) => row.number === 1);
    expect(invoice).toMatchObject({ number: 1, currency: "EUR", totalMinor: 8333 });
    expect(savedInvoice.invoiceDraft).toBeUndefined();
    expect((await fetch(base + "/back-office/timesheet/invoices/" + invoice.id + "/document?format=pdf", {
      headers: hostHeaders,
    })).status).toBe(404);
    expect(JSON.parse(await billing.execute({ action: "read", invoiceNumber: 1 }))).toMatchObject({
      number: 1, client: "Example", billingAddress: "1 Test Square", currency: "EUR", totalMinor: 8333,
      entries: [{ date: lockedDate, matter: "Lease", narrative: original, hourlyRate: 250, amountMinor: 8333 }],
    });
    const [approved] = (await chat({ date: lockedDate, action: "list_entries" })).entries;
    expect(approved).toMatchObject({ status: "invoiced", editable: false, removable: false });
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
}, 12_000);
