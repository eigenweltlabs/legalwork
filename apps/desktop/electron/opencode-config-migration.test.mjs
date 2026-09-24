import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { migrateLegacyWindowsOpenCodeConfig } from "./opencode-config-migration.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-windows-config-"));
  const source = path.join(root, "AppData", "Roaming", "opencode");
  const target = path.join(root, ".config", "opencode");
  try {
    await mkdir(source, { recursive: true });
    await run({ source, target });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function file(root, relative, content) {
  const pathname = path.join(root, relative);
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, content);
  return pathname;
}

test("copies the legacy config library into OpenCode's native root before discovery", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "skills/workflow-review/SKILL.md", "---\nname: workflow-review\ndescription: Review a matter.\n---\nReview it.\n");
    await file(source, "skills/workflow-review/references/checklist.md", "Check sources.\n");
    await file(source, "agents/reviewer.md", "Review documents.\n");
    await file(source, "commands/review.md", "Review the current matter.\n");
    await file(source, "plugins/helper.ts", "export default {};\n");
    await file(source, "instructions/firm.md", "Follow firm guidance.\n");
    await file(source, "AGENTS.md", "Firm instructions.\n");
    await file(source, "opencode.jsonc", '{\n  // Preserved when no native file exists\n  "model": "provider/legalwork"\n}\n');
    await file(source, "tui.json", '{"theme":"legacy"}\n');

    const first = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(first.failed.length, 0);
    assert.equal(first.conflicts.length, 0);
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), "Firm instructions.\n");
    assert.equal(await readFile(path.join(target, "skills/workflow-review/references/checklist.md"), "utf8"), "Check sources.\n");
    assert.equal(await readFile(path.join(target, "agents/reviewer.md"), "utf8"), "Review documents.\n");
    assert.equal(await readFile(path.join(target, "commands/review.md"), "utf8"), "Review the current matter.\n");
    assert.equal(await readFile(path.join(target, "plugins/helper.ts"), "utf8"), "export default {};\n");
    assert.equal(await readFile(path.join(target, "instructions/firm.md"), "utf8"), "Follow firm guidance.\n");
    assert.match(await readFile(path.join(target, "opencode.jsonc"), "utf8"), /Preserved when no native file exists/);
    assert.equal(await readFile(path.join(target, "tui.json"), "utf8"), '{"theme":"legacy"}\n');
    assert.equal(await readFile(path.join(source, "AGENTS.md"), "utf8"), "Firm instructions.\n");
    assert.deepEqual(await migrateLegacyWindowsOpenCodeConfig(source, target), { copied: 0, merged: 0, conflicts: [], skipped: [], failed: [] });
  });
});

test("preserves working native config and imports non-conflicting settings and skills", async () => {
  await fixture(async ({ source, target }) => {
    await file(target, "AGENTS.md", "Existing OpenCode instructions.\n");
    await file(source, "AGENTS.md", "Legacy LegalWork instructions.\n");
    await file(target, "skills/shared/SKILL.md", "Native skill.\n");
    await file(source, "skills/shared/SKILL.md", "Legacy skill.\n");
    await file(source, "skills/shared/references/legacy.md", "Legacy-only resource.\n");
    await file(source, "skills/new/SKILL.md", "New skill.\n");
    await file(target, "opencode.json", '{"model":"provider/native","mcp":{"existing":{"type":"remote","url":"https://example.test"}}}\n');
    await file(source, "opencode.jsonc", '{\n  "model": "provider/legacy",\n  "mcp": {"added": {"type":"remote","url":"https://legacy.test"}}\n}\n');

    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    assert.ok(result.conflicts.some((item) => item.endsWith("AGENTS.md")));
    assert.ok(result.conflicts.some((item) => item.endsWith(path.join("skills", "shared"))));
    assert.ok(result.conflicts.some((item) => item.includes(": model")));
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), "Existing OpenCode instructions.\n");
    assert.equal(await readFile(path.join(target, "skills/shared/SKILL.md"), "utf8"), "Native skill.\n");
    assert.deepEqual(await readdir(path.join(target, "skills", "shared")), ["SKILL.md"]);
    assert.equal(await readFile(path.join(target, "skills/new/SKILL.md"), "utf8"), "New skill.\n");
    const config = parse(await readFile(path.join(target, "opencode.json"), "utf8"));
    assert.equal(config.model, "provider/native");
    assert.ok(config.mcp.existing);
    assert.ok(config.mcp.added);
    const backups = await readdir(path.join(target, ".legalwork-migration-backup"));
    assert.equal(backups.length, 1);
    assert.equal(parse(await readFile(path.join(target, ".legalwork-migration-backup", backups[0]), "utf8")).mcp.added, undefined);
    assert.equal(await readFile(path.join(source, "skills/shared/SKILL.md"), "utf8"), "Legacy skill.\n");
  });
});

test("combines effective arrays across roots without reactivating overridden entries within a root", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "plugins/legacy.ts", "export default async () => ({});\n");
    await file(source, "instructions/legacy.md", "Legacy instructions.\n");
    await file(target, "plugins/native.ts", "export default async () => ({});\n");
    await file(target, "instructions/native.md", "Native instructions.\n");
    await file(source, "opencode.json", JSON.stringify({
      plugin: ["overridden-legacy-plugin"],
      instructions: ["overridden-legacy.md"],
      skills: { paths: ["skills/overridden-legacy"], urls: ["https://overridden-legacy.test/skills"] },
    }));
    await file(source, "opencode.jsonc", JSON.stringify({
      plugin: ["./plugins/legacy.ts", ["legacy-package", { mode: "test" }]],
      instructions: ["instructions/legacy.md"],
      skills: { paths: ["skills/legacy"], urls: ["https://legacy.test/skills"] },
    }));
    await file(target, "opencode.json", JSON.stringify({
      plugin: ["overridden-native-plugin"],
      instructions: ["overridden-native.md"],
      skills: { paths: ["skills/overridden-native"], urls: ["https://overridden-native.test/skills"] },
    }));
    await file(target, "opencode.jsonc", JSON.stringify({
      plugin: ["./plugins/native.ts"],
      instructions: ["instructions/native.md"],
      skills: { paths: ["skills/native"], urls: ["https://native.test/skills"] },
    }));

    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    assert.equal(result.conflicts.length, 0);
    const config = parse(await readFile(path.join(target, "opencode.jsonc"), "utf8"));
    assert.deepEqual(config.plugin, ["./plugins/native.ts", "./plugins/legacy.ts", ["legacy-package", { mode: "test" }]]);
    assert.deepEqual(config.instructions, ["instructions/native.md", "instructions/legacy.md"]);
    assert.deepEqual(config.skills.paths, ["skills/native", "skills/legacy"]);
    assert.deepEqual(config.skills.urls, ["https://native.test/skills", "https://legacy.test/skills"]);
    assert.deepEqual(parse(await readFile(path.join(target, "opencode.json"), "utf8")).plugin, ["overridden-native-plugin"]);
    assert.equal(await readFile(path.join(target, "plugins/legacy.ts"), "utf8"), "export default async () => ({});\n");
    assert.equal(await readFile(path.join(target, "instructions/legacy.md"), "utf8"), "Legacy instructions.\n");
  });
});

test("upgrades a completed first-version migration without duplicating config entries", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "opencode.jsonc", '{"plugin":["./plugins/legacy.ts"],"instructions":["instructions/legacy.md"]}\n');
    await file(target, "opencode.jsonc", '{"plugin":["./plugins/native.ts"],"instructions":["instructions/native.md"]}\n');
    await file(source, "plugins/legacy.ts", "Legacy plugin.\n");
    await file(target, "plugins/legacy.ts", "Legacy plugin.\n");
    await file(source, "skills/legacy/SKILL.md", "Legacy skill.\n");
    await file(target, "skills/legacy/SKILL.md", "Legacy skill.\n");
    await file(source, "skills/legacy/references/guide.md", "Read this.\n");
    await file(target, "skills/legacy/references/guide.md", "Read this.\n");
    await file(target, ".legalwork-windows-config-migration.json", JSON.stringify({ source, target, copied: 0, merged: 0, conflicts: [] }));

    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.conflicts, []);
    const config = parse(await readFile(path.join(target, "opencode.jsonc"), "utf8"));
    assert.deepEqual(config.plugin, ["./plugins/native.ts", "./plugins/legacy.ts"]);
    assert.deepEqual(config.instructions, ["instructions/native.md", "instructions/legacy.md"]);
    const marker = JSON.parse(await readFile(path.join(target, ".legalwork-windows-config-migration.json"), "utf8"));
    assert.equal(marker.version, 2);
    assert.deepEqual(await migrateLegacyWindowsOpenCodeConfig(source, target), { copied: 0, merged: 0, conflicts: [], skipped: [], failed: [] });
  });
});

test("leaves old SQLite data in AppData while copying other config assets", async () => {
  await fixture(async ({ source, target }) => {
    const database = await file(source, "opencode.db", "SQLite database bytes");
    const wal = await file(source, "opencode.db-wal", "SQLite WAL bytes");
    await file(source, "opencode-local.db", "Older channel database bytes");
    await file(source, "instructions/custom.md", "Custom instructions.\n");
    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.skipped.sort(), [database, wal, path.join(source, "opencode-local.db")].sort());
    assert.equal(await readFile(database, "utf8"), "SQLite database bytes");
    assert.equal(await readFile(path.join(target, "instructions", "custom.md"), "utf8"), "Custom instructions.\n");
    assert.deepEqual((await readdir(target)).filter((name) => name.endsWith(".db") || name.endsWith(".db-wal")), []);
    const marker = JSON.parse(await readFile(path.join(target, ".legalwork-windows-config-migration.json"), "utf8"));
    assert.deepEqual(marker.skipped.sort(), result.skipped);
  });
});

test("combines multiple legacy config files when the native root has none", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "opencode.json", '{"mcp":{"firm":{"type":"remote","url":"https://firm.test"}},"model":"provider/old","plugin":["overridden-plugin"],"instructions":["overridden.md"],"skills":{"paths":["skills/overridden"],"urls":["https://overridden.test/skills"]}}\n');
    await file(source, "opencode.jsonc", '{\n  // Higher-priority legacy setting\n  "model": "provider/new",\n  "plugin": ["active-plugin"],\n  "instructions": ["AGENTS.md"],\n  "skills": {"paths": ["skills/active"], "urls": ["https://active.test/skills"]}\n}\n');

    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    const config = parse(await readFile(path.join(target, "opencode.jsonc"), "utf8"));
    assert.equal(config.model, "provider/new");
    assert.deepEqual(config.plugin, ["active-plugin"]);
    assert.deepEqual(config.instructions, ["AGENTS.md"]);
    assert.deepEqual(config.skills.paths, ["skills/active"]);
    assert.deepEqual(config.skills.urls, ["https://active.test/skills"]);
    assert.ok(config.mcp.firm);
    assert.deepEqual((await readdir(target)).filter((name) => name === "opencode.json"), []);
  });
});

test("keeps malformed legacy config inactive and retries after it is repaired", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "opencode.jsonc", "{ invalid json\n");
    await file(source, "skills/working/SKILL.md", "Working skill.\n");
    const first = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(first.failed.length, 1);
    assert.equal(await readFile(path.join(target, "skills/working/SKILL.md"), "utf8"), "Working skill.\n");
    assert.deepEqual((await readdir(target)).filter((name) => name.startsWith("opencode.json")), []);
    assert.deepEqual((await readdir(target)).filter((name) => name.startsWith(".legalwork-windows-config-migration")), []);

    await file(source, "opencode.jsonc", '{"model":"provider/repaired"}\n');
    const second = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(second.failed.length, 0);
    assert.equal(parse(await readFile(path.join(target, "opencode.jsonc"), "utf8")).model, "provider/repaired");
    assert.equal((await readdir(target)).filter((name) => name.startsWith(".legalwork-windows-config-migration")).length, 1);
  });
});

test("redirects a legacy library junction to the copied directory", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "skills/real/SKILL.md", "Real skill.\n");
    const link = path.join(source, "skills", "linked");
    await symlink(path.join(source, "skills", "real"), link, process.platform === "win32" ? "junction" : "dir");
    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    assert.equal(await realpath(path.join(target, "skills", "linked")), await realpath(path.join(target, "skills", "real")));
  });
});

test("retries when a previous launch left an incomplete migration marker", async () => {
  await fixture(async ({ source, target }) => {
    await file(source, "skills/retry/SKILL.md", "Retry skill.\n");
    await file(target, ".legalwork-windows-config-migration.json", "{ incomplete");
    const result = await migrateLegacyWindowsOpenCodeConfig(source, target);
    assert.equal(result.failed.length, 0);
    assert.equal(await readFile(path.join(target, "skills/retry/SKILL.md"), "utf8"), "Retry skill.\n");
    assert.equal(JSON.parse(await readFile(path.join(target, ".legalwork-windows-config-migration.json"), "utf8")).target, target);
  });
});
