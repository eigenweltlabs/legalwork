import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson, readJson } from "./storage.js";

const roots: string[] = [];
const schema = z.object({ revision: z.number().int() });
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-storage-")));
  roots.push(root);
  const path = join(root, "review.json");
  await atomicJson(path, { revision: 0 });
  return { root, path };
}

test("review reads remain valid while atomic saves replace the file", async () => {
  const { path } = await fixture();
  const results = await Promise.allSettled([
    (async () => {
      for (let revision = 1; revision <= 250; revision++) await atomicJson(path, { revision });
    })(),
    (async () => {
      for (let i = 0; i < 1000; i++) {
        const value = await readJson(path, schema);
        expect(value.revision).toBeGreaterThanOrEqual(0);
        expect(value.revision).toBeLessThanOrEqual(250);
      }
    })(),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  expect(await readJson(path, schema)).toEqual({ revision: 250 });
});

test("review reads reject a symbolic link to a JSON file", async () => {
  const { root, path } = await fixture();
  const link = join(root, "linked.json");
  await symlink(path, link);
  await expect(readJson(link, schema)).rejects.toThrow("must not use symbolic links");
});

test("review reads reject a symbolic link in the parent path", async () => {
  const { root: target } = await fixture();
  const { root } = await fixture();
  const link = join(root, "linked-directory");
  await symlink(target, link);
  await expect(readJson(join(link, "review.json"), schema)).rejects.toThrow("must not use symbolic links");
});
