import assert from "node:assert/strict";
import { join } from "node:path";

export function readPackagedMailManifest(archive, asar) {
  const entry = join("server", "dist", "mail-node-runtime.json");
  assert.notEqual(asar.statFile(archive, entry).unpacked, true);
  return JSON.parse(asar.extractFile(archive, entry).toString("utf8"));
}
