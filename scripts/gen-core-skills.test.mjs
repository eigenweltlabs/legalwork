import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(repoRoot, "apps/app/package.json"));

function setLineEndings(directory, newline) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) setLineEndings(path, newline);
    else if (entry.isFile() && /\.(?:md|mjs|js|ts|py|json)$/.test(entry.name)) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/g, newline));
    }
  }
}

test("help generation accepts CRLF checkouts without hiding stale content", () => {
  const root = mkdtempSync(join(tmpdir(), "legalwork-help-crlf-"));
  try {
    for (const path of [
      "scripts/gen-core-skills.mjs", "scripts/help-docs.mjs",
      "apps/server/resources/core-opencode", "apps/server/src/core-skills.ts",
      "docs/user-guide", "apps/app/package.json", "apps/app/src/i18n",
      "apps/app/src/react-app/shell/app-root.tsx",
      "apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
      "packages/types/src/project-template-strings.ts",
    ]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, path), destination, { recursive: true });
    }
    // Resolve the package itself: linking pnpm's node_modules directory leaves
    // its relative package links pointing outside the fixture on Windows.
    mkdirSync(join(root, "apps/app/node_modules"), { recursive: true });
    symlinkSync(dirname(require.resolve("typescript/package.json")), join(root, "apps/app/node_modules/typescript"), "junction");
    const generated = ["docs/user-guide/i18n.json", "apps/server/src/help-i18n.generated.ts"];
    for (const path of generated) rmSync(join(root, path), { force: true });
    const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/gen-core-skills.mjs"), ...args], { cwd: root, encoding: "utf8" });

    setLineEndings(root, "\n");
    const baseline = run("--check");
    assert.equal(baseline.status, 0, baseline.stderr);
    const translations = readFileSync(join(root, generated[0]), "utf8");

    setLineEndings(root, "\r\n");
    for (const path of generated) rmSync(join(root, path), { force: true });
    const tracked = ["docs/user-guide/screens.json", "apps/server/src/core-skills.ts"];
    const before = tracked.map(path => readFileSync(join(root, path)));
    const windows = run("--check");
    assert.equal(windows.status, 0, windows.stderr);
    tracked.forEach((path, index) => assert.deepEqual(readFileSync(join(root, path)), before[index]));
    assert.equal(readFileSync(join(root, generated[0]), "utf8"), translations);
    assert.match(readFileSync(join(root, generated[1]), "utf8"), /export const HELP_I18N_JSON/);

    const page = join(root, "docs/user-guide/email.md");
    writeFileSync(page, readFileSync(page, "utf8") + "\r\nA real documentation change.\r\n");
    const stale = run("--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Out of date: .*core-skills\.ts/);
    const refreshed = run();
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const rechecked = run("--check");
    assert.equal(rechecked.status, 0, rechecked.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
