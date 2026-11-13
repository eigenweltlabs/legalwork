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

test("checks regenerate the ignored bundle and verify the tracked screen inventory on LF and CRLF checkouts", () => {
  const root = mkdtempSync(join(tmpdir(), "legalwork-help-crlf-"));
  try {
    for (const path of [
      "scripts/gen-core-skills.mjs", "scripts/help-docs.mjs",
      "apps/server/resources/core-opencode",
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
    mkdirSync(join(root, "apps/server/src"), { recursive: true });
    const bundle = join(root, "apps/server/src/core-skills.ts");
    const i18n = join(root, "docs/user-guide/i18n.json");
    const i18nModule = join(root, "apps/server/src/help-i18n.generated.ts");
    const inventory = join(root, "docs/user-guide/screens.json");
    const generated = [bundle, i18n, i18nModule];
    for (const path of generated) rmSync(path, { force: true });
    const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/gen-core-skills.mjs"), ...args], { cwd: root, encoding: "utf8" });

    setLineEndings(root, "\n");
    const baseline = run("--check");
    assert.equal(baseline.status, 0, baseline.stderr);
    const translations = readFileSync(i18n, "utf8");
    const baselineBundle = readFileSync(bundle);

    setLineEndings(root, "\r\n");
    for (const path of generated) rmSync(path, { force: true });
    const before = readFileSync(inventory);
    const windows = run("--check");
    assert.equal(windows.status, 0, windows.stderr);
    assert.deepEqual(readFileSync(inventory), before);
    assert.ok(readFileSync(bundle).equals(baselineBundle), "Checkout line endings changed the bundled files");
    assert.equal(readFileSync(i18n, "utf8"), translations);
    assert.match(readFileSync(i18nModule, "utf8"), /export const HELP_I18N_JSON/);

    const page = join(root, "docs/user-guide/email.md");
    writeFileSync(page, readFileSync(page, "utf8") + "\r\nA real documentation change.\r\n");
    const updated = run("--check");
    assert.equal(updated.status, 0, updated.stderr);
    assert.ok(readFileSync(bundle, "utf8").includes("A real documentation change."));
    assert.deepEqual(readFileSync(inventory), before);

    writeFileSync(inventory, "{}\r\n");
    const stale = run("--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Out of date: .*screens\.json/);
    assert.equal(readFileSync(inventory, "utf8"), "{}\r\n");
    const refreshed = run();
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const rechecked = run("--check");
    assert.equal(rechecked.status, 0, rechecked.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
