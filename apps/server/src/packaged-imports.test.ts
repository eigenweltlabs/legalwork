import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Glob } from "bun";

// The packaged app ships the server without the workspace's @legalwork/types package.
// Only files the build bundles (package.json "build") may use its values at runtime.
test("runtime code reaches @legalwork/types only through files the build bundles", async () => {
  const build: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts.build;
  const bundled = new Set(build.match(/src\/[\w/.-]+\.ts/g));
  const offending: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan({ cwd: new URL("..", import.meta.url).pathname })) {
    if (file.endsWith(".test.ts") || bundled.has(file)) continue;
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [, typeOnly] of source.matchAll(/(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+"@legalwork\/types[^"]*"/g))
      if (!typeOnly) offending.push(file);
  }
  expect(offending).toEqual([]);
});
