import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
    await writeFile(join(folder, "first.docx"), "example");
    const first = await localCaptureDocumentId(
      config,
      "project",
      "first.docx",
      true,
      profile.profileId,
    );
    await writeFile(join(folder, "replacement.docx"), "revised");
    await rename(join(folder, "replacement.docx"), join(folder, "first.docx"));
    expect(
      await localCaptureDocumentId(
        config,
        "project",
        "first.docx",
        false,
        profile.profileId,
      ),
    ).toBe(first);
    await rename(join(folder, "first.docx"), join(folder, "appeal.docx"));
    expect(
      await localCaptureDocumentId(
        config,
        "project",
        "appeal.docx",
        false,
        profile.profileId,
      ),
    ).toBe(first);
    expect(
      await localCaptureDocumentId(
        config,
        "project",
        "appeal.docx",
        false,
        "wrong-account",
      ),
    ).toBeUndefined();
    expect(first).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
