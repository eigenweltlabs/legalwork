#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isElectronReleaseAsset(file) {
  return basename(file).startsWith("legalwork-") &&
    (/\.(AppImage|blockmap|dmg|exe|rpm|zip)$/i.test(file) || /\.tar\.gz$/i.test(file));
}

export async function createChecksums(files) {
  if (!files.length) throw new Error("No Electron release assets to checksum.");
  const entries = new Map();
  for (const file of files) {
    const name = basename(file);
    if (/[\r\n\\]/.test(name)) throw new Error(`Unsupported checksum filename: ${name}`);
    if (entries.has(name)) throw new Error(`Duplicate release asset: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    entries.set(name, hash.digest("hex"));
  }
  return formatChecksums(entries);
}

function formatChecksums(entries) {
  return [...entries].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}\n`).join("");
}

export async function mergeChecksums(paths) {
  if (!paths.length) throw new Error("Missing platform SHA256SUMS artifacts.");
  const entries = new Map();
  for (const path of paths) {
    const content = await readFile(path, "utf8");
    if (!content.trim()) throw new Error(`Empty checksum list: ${path}`);
    for (const line of content.trimEnd().split(/\r?\n/)) {
      const match = line.match(/^([a-f0-9]{64})  (legalwork-[^/\\\r\n]+)$/);
      if (!match || !isElectronReleaseAsset(match[2])) throw new Error(`Invalid checksum entry in ${path}`);
      const [, digest, name] = match;
      if (entries.has(name) && entries.get(name) !== digest) {
        throw new Error(`Conflicting checksums for ${name}`);
      }
      entries.set(name, digest);
    }
  }
  return formatChecksums(entries);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [distRoot] = process.argv.slice(2);
  if (!distRoot) throw new Error("Usage: node scripts/release/checksums.mjs <dist-root>");
  const root = resolve(distRoot);
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isElectronReleaseAsset(entry.name))
    .map((entry) => join(root, entry.name));
  await writeFile(join(root, "SHA256SUMS"), await createChecksums(files));
}
