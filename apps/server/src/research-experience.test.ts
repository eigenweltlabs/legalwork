import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchExperience } from "./research-experience.js";
import { openSqlite, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

test("research experience persists, isolates providers, resolves failures and rejects stale or private updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-experience-"));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "config.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  const skill = { name: "research-fixture", directory: root, scope: "global", hash: "first-version" };
  const note = { key: "stale-sign-in", status: "unresolved", situation: "Sign-in link has expired.", attempt: "Reopened the old tab.", outcome: "The sign-in page still reported an expired link." };
  const save = (value: unknown, expectedRevision = 0) => researchExperience(config, "provider-a", skill, { action: "save", note: value, expectedRevision });
  try {
    expect((await save(note)).entries[0]).toMatchObject({ ...note, revision: 1, needsRecheck: false });
    expect((await save(note)).entries).toHaveLength(1); // Lost-response retry.
    const fixed = { ...note, status: "verified", attempt: "Returned to the database homepage and used its current sign-in control.", outcome: "The research interface opened and a search returned results." };
    expect((await save(fixed, 1)).entries[0]).toMatchObject({ status: "verified", revision: 2 });
    await expect(save(note, 1)).rejects.toMatchObject({ code: "research_experience_changed" });
    // Every call closes and reopens SQLite, including a fresh server config object.
    expect((await researchExperience({ ...config }, "provider-a", skill)).entries[0].outcome).toBe(fixed.outcome);
    expect((await researchExperience(config, "provider-b", skill)).entries).toEqual([]);
    expect((await researchExperience(config, "provider-a", { ...skill, hash: "updated-version" })).entries[0].needsRecheck).toBe(true);
    for (const outcome of ["https://example.test/login?code=secret", "username=example", "password: synthetic", "token=private", "user@example.test", "<input value='private'>", "x".repeat(701)]) {
      await expect(save({ ...fixed, outcome }, 2)).rejects.toBeDefined();
    }
    await expect(save({ ...fixed, password: "synthetic" }, 2)).rejects.toMatchObject({ code: "research_experience_invalid" });
    const parallel = await Promise.allSettled([save({ ...fixed, outcome: "Search results were visible." }, 2), save({ ...fixed, outcome: "The document page was visible." }, 2)]);
    expect(parallel.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(parallel.filter(result => result.status === "rejected")).toHaveLength(1);
    for (let index = 0; index < 29; index++) await save({ ...note, key: `issue-${index}` });
    await expect(save({ ...note, key: "overflow" })).rejects.toMatchObject({ code: "research_experience_full" });
    const db = await openSqlite(runtimeDbPath(config));
    try {
      const { needsRecheck, ...entry } = (await researchExperience(config, "provider-a", skill)).entries[0];
      const old = { ...entry, observedAt: "2020-01-01T00:00:00.000Z" };
      db.run("UPDATE research_skill_experience SET note_json=? WHERE plugin_id=? AND issue_key=?", [JSON.stringify(old), "provider-a", old.key]);
    } finally { db.close(); }
    expect((await researchExperience(config, "provider-a", skill)).entries[0].needsRecheck).toBe(true);
    await expect(researchExperience(config, "provider-a", skill, { action: "forget", key: note.key, expectedRevision: 2 })).rejects.toMatchObject({ code: "research_experience_changed" });
    const remaining = await researchExperience(config, "provider-a", skill, { action: "forget", key: note.key, expectedRevision: 3 });
    expect(remaining.entries).toHaveLength(29);
    expect(remaining.entries.some(entry => entry.key === note.key)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
