import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { acceptPrivateProposal } from "./routes.js";
import { digest } from "./private-workday.js";
import { randomUUID } from "node:crypto";
import type { CaptureProposal, WorkdayCorrection } from "@legalwork/types/time-capture";
import { correctWorkday } from "./correct-workday.js";
import { originalBillingComparison, proposalCommitment } from "./original.js";

function sample(timed: boolean) {
  const parent: CaptureProposal = {
    key: randomUUID(),
    digest: "",
    date: "2026-11-12",
    source: "calendar",
    narrative: "Original",
    activity: "EXM",
    projectId: "project",
    startAt: timed ? "2026-11-12T09:00:00Z" : null,
    endAt: timed ? "2026-11-12T09:30:00Z" : null,
    workedMinutes: timed ? 30 : null,
    dismissed: false,
  };
  parent.digest = proposalCommitment(parent);
  const saved = {
    originals: { [parent.digest]: parent },
    days: { [parent.date]: [{ eventKey: "calendar", proposal: parent }] },
  };
  const edit: WorkdayCorrection = {
    type: "correct",
    key: parent.key,
    digest: parent.digest,
    narrative: "Edited",
    matterId: "m1",
    projectId: "project",
    startAt: parent.startAt,
    endAt: parent.endAt,
    workedMinutes: parent.workedMinutes,
  };
  return { saved, parent, edit };
}
test("private split moves last 12 minutes, gives distinct stable identities and binds both to the first proposal", () => {
  const { saved, parent, edit } = sample(true);
  edit.split = { matterId: "m2", projectId: null, minutes: 12 };
  correctWorkday(saved, parent.date, edit, "Europe/Vienna");
  const [first, second] = saved.days[parent.date].map((item) => item.proposal);
  expect(first.key).toBe(parent.key);
  expect(second.key).not.toBe(first.key);
  expect(first).toMatchObject({
    startAt: parent.startAt,
    endAt: "2026-11-12T09:18:00.000Z",
    workedMinutes: 18,
    matterId: "m1",
  });
  expect(second).toMatchObject({
    startAt: first.endAt,
    endAt: parent.endAt,
    workedMinutes: 12,
    matterId: "m2",
  });
  for (const p of [first, second])
    expect(originalBillingComparison(saved.originals[p.digest], p.digest, saved.originals)).toEqual({
      digest: p.digest,
      originalDigest: parent.digest,
      date: parent.date,
      workedMinutes: 30,
      narrative: "Original",
      activity: "EXM",
    });
  expect(() => correctWorkday(saved, parent.date, edit, "Europe/Vienna")).toThrow(/Refresh/);
  expect(saved.days[parent.date]).toHaveLength(2);
});
test("unknown durations remain unknown, explicit durations can be split without inventing clock time", () => {
  const { saved, parent, edit } = sample(false);
  correctWorkday(saved, parent.date, edit, "Europe/Vienna");
  const updated = saved.days[parent.date][0].proposal;
  expect(updated.workedMinutes).toBeNull();
  expect(updated.startAt).toBeNull();
  correctWorkday(
    saved,
    parent.date,
    {
      ...edit,
      digest: updated.digest,
      workedMinutes: 20,
      split: { minutes: 12, matterId: "m2", projectId: null },
    },
    "Europe/Vienna",
  );
  expect(
    saved.days[parent.date].map((x) => [x.proposal.workedMinutes, x.proposal.startAt, x.proposal.endAt]),
  ).toEqual([
    [8, null, null],
    [12, null, null],
  ]);
});
test("range changes with a negative, incomplete, cross-day, or mismatched duration fail before modifying the original", () => {
  for (const fields of [
    { endAt: null },
    { endAt: "2026-11-11T12:00:00Z" },
    { endAt: "2026-11-13T01:00:00Z" },
    { workedMinutes: 29 },
  ]) {
    const { saved, parent, edit } = sample(true);
    expect(() => correctWorkday(saved, parent.date, { ...edit, ...fields }, "Europe/Vienna")).toThrow();
    expect(saved.days[parent.date][0].proposal).toBe(parent);
  }
});

test("booking only the current private segment serializes a stale draft, preserving safe idempotent retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-private-split-"));
  try {
    const config = backOfficeTestConfig(root);
    const { saved, parent, edit } = sample(true);
    edit.split = { minutes: 12, matterId: "second", projectId: null };
    correctWorkday(saved, parent.date, edit, "Europe/Vienna");
    const dir = join(root, "private-timesheets"),
      path = join(dir, digest(["local", "local"]) + ".json");
    await mkdir(dir);
    await writeFile(
      path,
      JSON.stringify({
        ...saved,
        lastRun: 0,
        settings: { calendar: true, tasks: false, intervalMinutes: 0 },
      }),
    );
    const identity = { user: "local", principal: "", scope: "local" },
      booked = new Set<string>();
    const issue = (key: string, hash: string) =>
      acceptPrivateProposal(config, identity, key, hash, async () => {
        booked.add(key);
        return "ok";
      });
    await expect(issue(parent.key, parent.digest)).rejects.toMatchObject({ status: 409 });
    expect(booked.size).toBe(0);
    const [rest, moved] = saved.days[parent.date].map((x) => x.proposal);
    await issue(rest.key, rest.digest);
    await issue(rest.key, rest.digest);
    await issue(moved.key, moved.digest);
    expect(booked.size).toBe(2);
    expect(JSON.parse(await readFile(path, "utf8")).accepted).toEqual({
      [rest.key]: rest.digest,
      [moved.key]: moved.digest,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
