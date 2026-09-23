import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { migrateInstalledWorkflows } from "./skill-migration.mjs";

async function withLibrary(run) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-skill-migration-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function skillFile(root, name, content, category) {
  const dir = path.join(root, ...(category ? [category] : []), name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, content);
  return file;
}

function metadata(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match);
  return parse(match[1]);
}

test("repairs previously imported workflows before engine discovery and is idempotent", async () => {
  await withLibrary(async (root) => {
    const direct = await skillFile(root, "workflow-assistant-irp2", "---\ndescription: Evaluate a product.\n---\n\n# IRP2\nFollow these steps.\n");
    const nested = await skillFile(root, "workflow-assistant-evaluation", "# Evaluation\nEvaluate the product.\n", "patents");
    const renamed = await skillFile(root, "workflow-assistant-renamed", "---\nname: old-name\ndescription: Review evidence.\n---\nBody\n");
    const first = await migrateInstalledWorkflows(root);
    assert.deepEqual(first, { migrated: 3, failed: [] });
    assert.deepEqual(metadata(await readFile(direct, "utf8")), {
      name: "workflow-assistant-irp2",
      description: "Evaluate a product.",
    });
    assert.match(await readFile(direct, "utf8"), /# IRP2\nFollow these steps\./);
    assert.equal(metadata(await readFile(nested, "utf8")).name, "workflow-assistant-evaluation");
    assert.equal(metadata(await readFile(renamed, "utf8")).name, "workflow-assistant-renamed");
    assert.deepEqual(await migrateInstalledWorkflows(root), { migrated: 0, failed: [] });
  });
});

test("leaves valid and unrepairable files untouched without blocking other workflows", async () => {
  await withLibrary(async (root) => {
    const validContent = "---\nname: workflow-assistant-valid\ndescription: Already loadable.\n---\n\n# Valid\n";
    const valid = await skillFile(root, "workflow-assistant-valid", validContent);
    const invalidContent = "---\ndescription: [broken\n---\nBody\n";
    const invalid = await skillFile(root, "workflow-assistant-broken", invalidContent);
    const ordinaryContent = "---\ndescription: An ordinary skill.\n---\nBody\n";
    const ordinary = await skillFile(root, "ordinary-skill", ordinaryContent);
    const result = await migrateInstalledWorkflows(root);
    assert.equal(result.migrated, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].file, invalid);
    assert.equal(await readFile(valid, "utf8"), validContent);
    assert.equal(await readFile(invalid, "utf8"), invalidContent);
    assert.equal(await readFile(ordinary, "utf8"), ordinaryContent);
  });
});

test("preserves workflow file permissions and handles an absent library", async () => {
  await withLibrary(async (root) => {
    const file = await skillFile(root, "workflow-assistant-private", "---\ndescription: Keep private.\n---\nBody\n");
    const before = (await stat(file)).mode & 0o777;
    assert.equal((await migrateInstalledWorkflows(root)).migrated, 1);
    assert.equal((await stat(file)).mode & 0o777, before);
    assert.deepEqual(await migrateInstalledWorkflows(path.join(root, "missing")), { migrated: 0, failed: [] });
  });
});
