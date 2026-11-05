import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Glob } from "bun";

// The packaged app ships the server without the workspace's @legalwork/types package.
// Only files the build bundles (package.json "build") may use its values at runtime.
test("runtime code reaches @legalwork/types only through files the build bundles", async () => {
  const build: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts.build;
  const bundled = new Set(build.match(/src\/[\w/.-]+\.ts/g));
  const pluginBuild = await readFile(new URL("../scripts/build-opencode-plugins.ts", import.meta.url), "utf8");
  const names = pluginBuild.match(/export const pluginNames = \[([\s\S]*?)\];/)?.[1];
  expect(names).toBeDefined();
  for (const [name] of (names ?? "").matchAll(/"(legalwork-[\w-]+)"/g)) bundled.add(`src/opencode-plugins/${name.slice(1, -1)}.ts`);
  const offending: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan({ cwd: new URL("..", import.meta.url).pathname })) {
    if (file.endsWith(".test.ts") || bundled.has(file)) continue;
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [, typeOnly] of source.matchAll(/(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+"@legalwork\/types[^"]*"/g))
      if (!typeOnly) offending.push(file);
  }
  expect(offending).toEqual([]);
});

test("the built native shared boundary runs in plain Node without workspace packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-packaged-shared-"));
  try {
    const output = join(root, "native-shared-values.mjs");
    // A child CLI build also exercises the same build path used for packaging.
    const built = spawnSync(process.execPath, ["build", new URL("./native-shared-values.ts", import.meta.url).pathname, "--outfile", output, "--target", "node", "--format", "esm", "--external", "zod"], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    expect(await readFile(output, "utf8")).not.toContain("@legalwork/types");
    await mkdir(join(root, "node_modules"));
    await symlink(dirname(createRequire(import.meta.url).resolve("zod/package.json")), join(root, "node_modules", "zod"), "dir");
    const executed = spawnSync("node", ["--input-type=module", "-e", `
      import {automaticAssistantBrowserModel, inferNativeDefaultVariant, isInternalSession, isRetiredRemoteWorkspace, LegalMemoryPermissionReplySchema, ScheduledTaskMessageSchema, isReviewWorkerSession, browserPasswordRequestSchema, codeModeWidgetResults, toolDisplayText} from ${JSON.stringify(new URL(`file://${output}`).href)};
      if (automaticAssistantBrowserModel([{providerID:'eigenwelt',id:'fixture',name:'GPT-6.1 Terra (EU)'}])?.id !== 'fixture') throw new Error('missing browser model default');
      if (inferNativeDefaultVariant({headers:{'X-Mode':'careful'},variants:[{id:'Careful',headers:{'x-mode':'careful'}}]}) !== 'Careful') throw new Error('variant inference changed');
      if (typeof isInternalSession !== 'function' || typeof isRetiredRemoteWorkspace !== 'function' || typeof isReviewWorkerSession !== 'function') throw new Error('missing runtime guard');
      if (typeof codeModeWidgetResults !== 'function' || toolDisplayText([{type:'text',text:'retained tool output'}]) !== 'retained tool output') throw new Error('missing shared chat tool helpers');
      if (!LegalMemoryPermissionReplySchema.safeParse || !ScheduledTaskMessageSchema.safeParse || !browserPasswordRequestSchema.safeParse) throw new Error('missing runtime schema');
    `], { cwd: root, encoding: "utf8" });
    expect(executed.status, executed.stderr).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
