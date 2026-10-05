import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "../types.js";
import { CalendarCreateSchema, CalendarItemSchema } from "./schema.js";
import { validateCalendarLinks } from "./links.js";
import { CalendarStore } from "./store.js";
import { exportCalendar, parseCalendar } from "./ical.js";
import { scopeIncludes } from "../project-sync.js";
import { fileKey } from "../project-file-sync.js";

test("deadline links validate project files and sessions without allowing traversal or symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-links-")), path = join(root, "project");
  const workspace: WorkspaceInfo = { id: "project", name: "Project", path, preset: "starter", workspaceType: "local" };
  await mkdir(path); await writeFile(join(path, "Court order.pdf"), "order"); await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(path, "escape.txt"));
  const getSession = async (_workspace: unknown, id: string) => id === "missing" ? null : { directory: id === "own" ? path : root };
  try {
    await validateCalendarLinks(workspace, { attachmentPaths: ["Court order.pdf"], sessionIds: ["own"] }, undefined, getSession);
    for (const unsafe of ["../private.txt", "/private.txt", ".legalwork/private.json", "a\\b", "a//b", "a/../b"]) {
      expect(CalendarCreateSchema.safeParse({ title: "Test", start: "2026-10-01", attachmentPaths: [unsafe] }).success).toBe(false);
    }
    for (const file of ["escape.txt", "missing.pdf"]) await expect(validateCalendarLinks(workspace, { attachmentPaths: [file] }, undefined, getSession)).rejects.toThrow();
    for (const session of ["other", "missing"]) await expect(validateCalendarLinks(workspace, { sessionIds: [session] }, undefined, getSession)).rejects.toThrow();
    // Previously linked sources can be unavailable while unrelated edits still save.
    await validateCalendarLinks(workspace, { attachmentPaths: ["missing.pdf"], sessionIds: ["missing"] }, { attachmentPaths: ["missing.pdf"], sessionIds: ["missing"] }, getSession);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachments survive revision history and iCalendar round trips; sessions remain local", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-attachments-"));
  try {
    const store = await CalendarStore.open(join(root, "runtime.sqlite"));
    const entry = store.create("p", { title: "Deadline", start: "2026-10-01", attachmentPaths: ["Orders/Änderung.pdf"], sessionIds: ["ses_local"] });
    const { attachmentPaths: _files, sessionIds: _sessions, ...legacy } = entry;
    expect(CalendarItemSchema.parse(legacy)).toMatchObject({ attachmentPaths: [], sessionIds: [] });
    const event = parseCalendar(exportCalendar([entry])).getFirstSubcomponent("vevent");
    expect(event?.getFirstPropertyValue("attach")).toBe("legalwork-file:Orders%2F%C3%84nderung.pdf");
    expect(entry.ical).not.toContain("ses_local");
    const [copy] = store.import("copy", exportCalendar([entry]), "test");
    // An imported URI is retained, but cannot silently attach a file from the receiving project.
    expect(copy.attachmentPaths).toEqual([]); expect(copy.sessionIds).toEqual([]);
    expect(copy.ical).toContain("ATTACH:legalwork-file:");
    const updated = store.patch("p", entry.id, { revision: entry.revision, attachmentPaths: [] });
    expect(updated.ical).not.toContain("ATTACH:"); expect(updated.sessionIds).toEqual(["ses_local"]);
    expect(store.history("p", entry.id)[1].attachmentPaths).toEqual(entry.attachmentPaths);
    store.receive("p", { ...updated, sessionIds: ["ses_foreign"], revision: 10 }, updated.revision);
    expect(store.get("p", entry.id).sessionIds).toEqual(["ses_local"]);
    // A received conflict must also keep this machine's session links.
    const current = store.get("p", entry.id), local = store.patch("p", entry.id, { revision: current.revision, title: "Mine" });
    store.receive("p", { ...updated, sessionIds: ["ses_foreign"], title: "Theirs", revision: 11 });
    expect(store.resolve("p", entry.id, local.revision, "theirs").sessionIds).toEqual(["ses_local"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("calendar-only sharing includes just its attached files", () => {
  const scope = { calendar: true, documents: false, notes: false, recordings: false, reviews: false, tasks: false, metadata: false };
  const attached = new Set([fileKey("Orders/Order.pdf"), fileKey("Notes/Service.md")]);
  expect(scopeIncludes(scope, "Orders/Order.pdf", undefined, attached)).toBe(true);
  expect(scopeIncludes(scope, "Notes/Service.md", undefined, attached)).toBe(true);
  expect(scopeIncludes(scope, "Orders/Unrelated.pdf", undefined, attached)).toBe(false);
  expect(scopeIncludes({ ...scope, calendar: false }, "Orders/Order.pdf", undefined, attached)).toBe(false);
});
