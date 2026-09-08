import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");

// resolveAppIconPath() in main.mjs falls back to `process.resourcesPath/icons`
// once the repo-relative paths miss, which is every packaged build -- `files:`
// packs only electron/, server/ and package.json, so resources/ never lands in
// the asar. Nothing copied the icons there, so both the light and the dark
// plate resolved to null and app.dock.setIcon() was never called: the dock kept
// the static .icns and could not follow the system appearance. Only `dev` swapped.
const REQUIRED_ICONS = ["icon.png", "icon-dark.png"];

function readBuilderConfig() {
  return readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
}

// The yml is not parsed: js-yaml is only present here transitively via
// electron-builder, and a dependency added for one assertion buys less than
// matching the block we actually care about.
function iconsExtraResourceBlock(config) {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => /^\s*-\s*from:\s*resources\/icons\s*$/.test(line));
  if (start === -1) return null;
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s*from:/.test(line) || /^\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

test("electron-builder copies the runtime app icons into Resources/icons", () => {
  const block = iconsExtraResourceBlock(readBuilderConfig());
  assert.ok(
    block,
    "electron-builder.yml has no extraResources entry for resources/icons; a packaged build resolves no app icon and the dock cannot follow dark mode",
  );
  assert.match(
    block,
    /^\s*to:\s*icons\s*$/m,
    `resources/icons must be copied to "icons" -- resolveAppIconPath() reads process.resourcesPath/icons. Got:\n${block}`,
  );
  for (const icon of REQUIRED_ICONS) {
    assert.match(block, new RegExp(`^\\s*-\\s*${icon.replace(".", "\\.")}\\s*$`, "m"),
      `${icon} is filtered out of the packaged icons. Got:\n${block}`);
  }
});

test("the icons the packaged app resolves exist in the repo", () => {
  for (const icon of REQUIRED_ICONS) {
    const iconPath = path.join(desktopDir, "resources", "icons", icon);
    assert.ok(existsSync(iconPath), `missing packaged app icon: ${iconPath}`);
  }
});
