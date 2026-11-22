import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import {
  currentActivityProfile,
  exclusiveForeground,
  localCaptureDocumentId,
  readActivityEvidence,
  recordCompletedTask,
  recordWorkspaceObservations,
} from "./activity-workday.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { taskStore } from "../task-store.js";
import { saveWorkdayLog } from "./day-log.js";
import { digest } from "./private-workday.js";

test("new foreground wins across overlapping windows; a background run remains separate", () => {
  const a = {
    kind: "foreground" as const,
    projectId: "a",
    stream: "A",
    start: 10,
    end: 30,
  };
  const b = { ...a, projectId: "b", stream: "B", start: 20, end: 35 };
  const run = { ...a, kind: "agent" as const, stream: "run" };
  expect(exclusiveForeground([b, run, a])).toEqual([run, { ...a, end: 20 }, b]);
});
test("task completion date, stable identity through editor replacement and rename, cross-account rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "workday-observe-"));
  try {
    const folder = join(root, "project");
    await mkdir(folder);
    const config = backOfficeTestConfig(root, {
      workspaces: [
        {
          id: "project",
          name: "Project",
          path: folder,
          preset: "starter",
          workspaceType: "local",
        },
      ],
    });
    const profile = await currentActivityProfile(config);
    await recordCompletedTask(config, profile, {
      id: "without-due-date",
      title: "Telephone conference",
      updatedAt: "2026-11-19T23:20:00Z",
    });
    const [task] = await readActivityEvidence(
      config,
      profile,
      "2026-11-20",
      "Europe/Vienna",
    );
    expect(task.proposal).toMatchObject({
      source: "tasks",
      narrative: "Telephone conference",
      startAt: null,
      workedMinutes: null,
    });
    expect(
      await readActivityEvidence(
        config,
        profile,
        "2026-11-19",
        "Europe/Vienna",
      ),
    ).toEqual([]);
    await expect(
      recordWorkspaceObservations(config, {
        profileId: "x".repeat(64),
        observations: [],
      }),
    ).rejects.toThrow();
    const now = Date.now();
    const agent = (start: number, end: number) => ({ projectId: "project", kind: "agent" as const, stream: "same-run", start: now + start, end: now + end });
    await recordWorkspaceObservations(config, { profileId: profile.profileId, observations: [
      agent(-90_000, -60_000), agent(-40_000, -10_000), agent(-80_000, -20_000),
    ] });
    const day = new Date(now - 90_000).toISOString().slice(0, 10);
    const agentEvidence = (await readActivityEvidence(config, profile, day, "UTC")).filter(item => item.proposal.source === "agent");
    expect(agentEvidence).toHaveLength(1);
    expect(agentEvidence[0].proposal.startAt).toBe(new Date(now - 90_000).toISOString());
    const firstPath = join(folder, "first.docx"), replacement = join(folder, "replacement.docx"), moved = join(folder, "appeal.docx");
    await writeFile(firstPath, "example");
    const before = await stat(firstPath);
    const first = await localCaptureDocumentId(config, profile, "project", null, before);
    await writeFile(replacement, "revised");
    await rename(replacement, firstPath);
    expect(await localCaptureDocumentId(config, profile, "project", before, await stat(firstPath))).toBe(first);
    await rename(firstPath, moved);
    expect(await localCaptureDocumentId(config, profile, "project", null, await stat(moved))).toBe(first);
    expect(await localCaptureDocumentId(config, { ...profile, profileId: "wrong-account" }, "project", null, await stat(moved))).toBeUndefined();
    expect(first).toBeTruthy();
    // Older profiles may still have a cached UUID for the old path. The new file is independent.
    const registry = profile.path + ".documents.json";
    const legacy = JSON.parse(await readFile(registry, "utf8"));
    await writeFile(registry, JSON.stringify({ ...legacy, [digest(["project", "first.docx"])]: first }));
    await writeFile(firstPath, "different file created outside the editor");
    const independent = await stat(firstPath);
    await writeFile(replacement, "edited version of the independent file");
    await rename(replacement, firstPath);
    const second = await localCaptureDocumentId(config, profile, "project", independent, await stat(firstPath));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await localCaptureDocumentId(config, profile, "project", null, await stat(moved))).toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronized firm's task contributes only notes written by this member on the day", async () => {
  const root = await mkdtemp(join(tmpdir(), "firm-task-daylog-"));
  try {
    const config = backOfficeTestConfig(root), at = "2026-11-22T10:42:00.000Z";
    await writeEigenweltConnection(config, { platformURL: eigenweltPlatformUrl(),
      account: { userId: "worker", orgId: "firm", orgName: "Fixture", orgRole: "org:member", userName: null, userEmail: null } });
    const owner = await currentActivityProfile(config), tasks = await taskStore(config);
    const seed = tasks.createTask({ title: "Synthetic review" }, { userId: null, name: null, email: null });
    const note = { id: "worker-note", authorUserId: "worker", authorName: null, authorEmail: null, source: "member" as const, createdAt: at, body: "private text" };
    const remote = { ...seed, id: crypto.randomUUID(), projectId: null, submission: null, attachments: [], notes: [
      note, { ...note, id: "colleague", authorUserId: "other" }, { ...note, id: "agent", source: "agent" as const },
      { ...note, id: "older", createdAt: "2026-11-20T10:00:00Z" },
    ] };
    tasks.applyRemoteTask(remote, "firm");
    tasks.applyRemoteTask({ ...remote, id: crypto.randomUUID(), title: "Different firm", notes: [{ ...note, id: "other-firm" }] }, "other");
    const rows = await readActivityEvidence(config, owner, "2026-11-22", "UTC");
    expect(rows).toHaveLength(1);
    expect(rows[0].proposal).toMatchObject({ narrative: "Synthetic review", changeSummary: "Added note", observedAt: at, workedMinutes: null });
    await saveWorkdayLog(owner.path, "2026-11-22", "UTC", at, rows);
    const journal = await readFile(join(owner.path + ".day-log", "2026-11-22.json"), "utf8");
    expect(journal).not.toContain("private text");
    expect(journal).not.toContain("Different firm");
  } finally { await rm(root, { recursive: true, force: true }); }
});
