import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backOfficeTestConfig } from "./config.test-support.js";
import { backOfficeStore, closeBackOfficeStoreForTests } from "./store.js";
import { backOfficeAccess, backOfficeDirectoryIdentity } from "./access.js";
import { nativeRows } from "./native-rows.js";
import { changeNativeLinks, nativeSources, prepareFormLinks, visibleNativeLinks } from "./native-links.js";
import { writeNative } from "./native-write.js";
import { calculateDeadline } from "../calendar/deadline-rules.js";
import { ANONYMOUS_ACTOR } from "../task-store.js";
import { runtimeDbPath } from "../runtime-db.js";

test("native tables edit original records, preserve deadline receipts and resolve links from either side", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-records-"));
  const config = backOfficeTestConfig(root, {
    workspaces: [{ id: "project", name: "Example", path: root, preset: "starter", workspaceType: "local" }],
  });
  if (runtimeDbPath(config) !== join(root, "runtime.sqlite"))
    throw Error("The fixture requires its own database");
  const access = await backOfficeAccess(config),
    store = await backOfficeStore(config);
  try {
    const directoryId = await backOfficeDirectoryIdentity(config, access.scope, store);
    const base = {
      id: crypto.randomUUID(),
      directoryId,
      userId: access.actor.userId,
      workspaceId: "project",
    };
    const write = (kind: "task" | "deadline", body: Record<string, unknown>) =>
      writeNative(config, store, access.scope, access.actor, kind, { ...base, ...body });
    await write("task", { action: "create", fields: { name: "Prepare response" } });
    await write("task", {
      action: "edit",
      fields: { priority: "1", status: "done", due: "2027-03-14", tags: ["Urgent"] },
    });
    const sources = await nativeSources(config);
    expect(sources.tasks.getTask(base.id)).toMatchObject({
      status: "done",
      priority: 1,
      dueDate: "2027-03-14",
      tags: ["Urgent"],
    });
    await expect(
      write("task", { action: "edit", fields: { name: "New" }, expected: { name: "Someone else's title" } }),
    ).rejects.toMatchObject({ code: "native_field_conflict" });
    const target = store.saveRecord("local", access.actor, {
      objectId: "matters",
      revision: 0,
      values: { name: "Acme" },
    });
    const source = { kind: "task" as const, projectKey: "", sourceId: base.id };
    changeNativeLinks(store, access, sources, source, [target.id], []);
    expect(visibleNativeLinks(store, access, sources, { recordId: target.id })).toEqual([
      { ...source, recordId: target.id },
    ]);
    expect(
      (await nativeRows(config, store, "local", access.actor, "task", false, "project")).records[0].record
        .values.linked,
    ).toEqual([target.id]);
    await expect(write("task", { action: "archive", directoryId: "other-firm" })).rejects.toMatchObject({
      code: "native_account",
    });
    expect(() =>
      changeNativeLinks(
        store,
        { ...access, actor: { ...access.actor, edit: false } },
        sources,
        source,
        [],
        [target.id],
      ),
    ).toThrow();
    expect(() => changeNativeLinks(store, access, sources, source, [crypto.randomUUID()], [])).toThrow();
    await write("task", { action: "archive" });
    expect(visibleNativeLinks(store, access, sources)).toHaveLength(0);
    await write("task", { action: "restore" });
    expect(visibleNativeLinks(store, access, sources)).toHaveLength(1);

    const calc = calculateDeadline({
      rule: "de-zpo-period",
      region: "NW",
      triggerDate: "2026-01-31",
      duration: 1,
      unit: "months",
      source: "Test order",
    });
    const receipt = sources.calendars.recordCalculation("project", calc, "fixture");
    const item = sources.calendars.create(
      "project",
      { title: "Appeal", start: receipt.deadlineDay, timeZone: receipt.timeZone },
      receipt.id,
    );
    const edit = { action: "edit", id: item.id, fields: { due: "2026-03-03" } };
    await expect(write("deadline", edit)).rejects.toMatchObject({ code: "override_reason_required" });
    await write("deadline", { ...edit, reason: "Extension granted" });
    expect(sources.calendars.history("project", item.id).map((r) => r.provenance.kind)).toEqual([
      "manual",
      "calculated",
    ]);
    const newId = crypto.randomUUID(),
      create = {
        id: newId,
        action: "create",
        fields: { name: "Second deadline", due: "2026-12-11", zone: "Europe/Berlin" },
      };
    await write("deadline", create);
    await write("deadline", create);
    expect(sources.calendars.list("project").filter((r) => r.id === newId)).toHaveLength(1);
    expect(store.records("local", access.actor).map((r) => r.id)).toEqual([target.id]);
  } finally {
    await closeBackOfficeStoreForTests(config);
    await rm(root, { force: true, recursive: true });
  }
});


test("task and deadline forms commit links with their native record and merge link-only edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-form-links-"));
  const config = backOfficeTestConfig(root, {
    workspaces: [{ id: "project", name: "Example", path: root, preset: "starter", workspaceType: "local" }],
  });
  const access = await backOfficeAccess(config), store = await backOfficeStore(config);
  try {
    const sources = await nativeSources(config);
    const guard = { directoryId: await backOfficeDirectoryIdentity(config, access.scope, store), userId: access.actor.userId };
    const record = (objectId: string, name: string) => store.saveRecord("local", access.actor, { objectId, revision: 0, values: { name } }).id;
    const matter = record("matters", "Form matter"), person = record("people", "Form person");
    const links = async (kind: "task" | "deadline", add: string[], remove: string[] = []) => {
      const prepared = await prepareFormLinks(config, { ...guard, add, remove }, kind, "project");
      if (!prepared) throw Error("Missing writer");
      return prepared.write;
    };
    const id = crypto.randomUUID();
    const input = { title: "Prepare file", id, projectId: "project" };
    const invalidTask = await links("task", [matter, crypto.randomUUID()]);
    expect(() => sources.tasks.createTask(input, ANONYMOUS_ACTOR, undefined, invalidTask)).toThrow();
    expect(sources.tasks.getTask(id)).toBeNull();
    sources.tasks.createTask(input, ANONYMOUS_ACTOR, undefined, await links("task", [matter, person]));
    const task = { kind: "task" as const, sourceId: id, projectKey: "" };
    expect(visibleNativeLinks(store, access, sources, task).map(r => r.recordId).sort()).toEqual([matter, person].sort());

    const deadline = sources.calendars.create("project", { title: "File", start: "2026-11-27" }, undefined, undefined, undefined, await links("deadline", [matter]));
    const source = { kind: "deadline" as const, sourceId: deadline.id, projectKey: "project" };
    const invalidDeadline = await links("deadline", [crypto.randomUUID()]);
    expect(() => sources.calendars.patch("project", deadline.id, { title: "Unsaved", revision: 1 }, invalidDeadline)).toThrow();
    expect(sources.calendars.get("project", deadline.id).title).toBe("File");
    sources.calendars.patch("project", deadline.id, { revision: 1, title: "Updated elsewhere" });
    sources.calendars.patch("project", deadline.id, { revision: 1 }, await links("deadline", [person], [matter]));
    expect(sources.calendars.get("project", deadline.id)).toMatchObject({ title: "Updated elsewhere", revision: 2 });
    expect(visibleNativeLinks(store, access, sources, source).map(r => r.recordId)).toEqual([person]);
    expect(visibleNativeLinks(store, access, sources, { recordId: person })).toHaveLength(2);
  } finally {
    await closeBackOfficeStoreForTests(config);
    await rm(root, { force: true, recursive: true });
  }
});
