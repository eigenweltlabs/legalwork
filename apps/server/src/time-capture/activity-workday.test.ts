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
