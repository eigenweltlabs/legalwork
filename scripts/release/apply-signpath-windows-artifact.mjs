#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [signedArtifactDirArg, distDirArg] = process.argv.slice(2);

if (!signedArtifactDirArg || !distDirArg) {
  console.error("Usage: node scripts/release/apply-signpath-windows-artifact.mjs <signed-artifact-dir> <dist-dir>");
  process.exit(2);
}

const signedArtifactDir = resolve(signedArtifactDirArg);
const distDir = resolve(distDirArg);
const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const YAML = desktopRequire("yaml");
const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
// Use the same generator as the installed electron-builder version. Recent
// electron-builder releases implement this in JS and no longer ship app-builder-bin.
const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");

function walk(dir) {
  const entries = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
    else if (stat.isFile()) entries.push(path);
  }
  return entries;
}

function findOne(paths, description) {
  if (paths.length !== 1) {
    console.error(`Expected exactly one ${description}, found ${paths.length}.`);
    for (const path of paths) console.error(`- ${path}`);
    process.exit(1);
  }
  return paths[0];
}

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

async function regenerateBlockmap(installerPath) {
  const blockmapPath = `${installerPath}.blockmap`;
  mkdirSync(dirname(blockmapPath), { recursive: true });
  await buildBlockMap(installerPath, "gzip", blockmapPath);
  if (!existsSync(blockmapPath)) {
    throw new Error(`electron-builder did not create ${blockmapPath}`);
  }
}

function updateLatestYml(installerPath) {
  const latestPath = join(distDir, "latest.yml");
  if (!existsSync(latestPath)) {
    throw new Error(`Missing Windows updater manifest: ${latestPath}`);
  }

  const installerName = basename(installerPath);
  const installerSha512 = sha512(installerPath);
  const installerSize = statSync(installerPath).size;
  const manifest = YAML.parse(readFileSync(latestPath, "utf8"));

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid Windows updater manifest: ${latestPath}`);
  }

  let matchedFile = false;
  manifest.files = manifest.files.map((file) => {
    if (!file || file.url !== installerName) return file;
    matchedFile = true;
    return {
      ...file,
      sha512: installerSha512,
      size: installerSize,
    };
  });

  if (!matchedFile) {
    throw new Error(`Manifest ${latestPath} does not reference signed installer ${installerName}`);
  }

  manifest.path = installerName;
  manifest.sha512 = installerSha512;
  writeFileSync(latestPath, YAML.stringify(manifest), "utf8");
}

if (!existsSync(signedArtifactDir)) {
  console.error(`Signed artifact directory does not exist: ${signedArtifactDir}`);
  process.exit(1);
}
if (!existsSync(distDir)) {
  console.error(`Electron dist directory does not exist: ${distDir}`);
  process.exit(1);
}

const signedInstaller = findOne(
  walk(signedArtifactDir).filter((file) => /^legalwork-win-(?:x64|arm64)-.+\.exe$/i.test(basename(file))),
  "signed Windows installer from SignPath",
);
const distInstaller = findOne(
  walk(distDir).filter((file) => basename(file) === basename(signedInstaller)),
  "matching unsigned Windows installer in dist-electron",
);

copyFileSync(signedInstaller, distInstaller);
await regenerateBlockmap(distInstaller);
updateLatestYml(distInstaller);

console.log(`Applied signed Windows installer: ${distInstaller}`);
