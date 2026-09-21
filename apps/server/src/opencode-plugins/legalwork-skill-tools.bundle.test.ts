import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("packaged skill tools initialize through the OpenCode export contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-skill-plugin-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "legalwork-skill-tools.ts")],
      outdir: directory,
      target: "node",
      format: "esm",
    });
    expect(build.success).toBe(true);
    const module = await import(pathToFileURL(build.outputs[0]!.path).href);
    // OpenCode treats every legacy module export as a plugin initializer.
    expect(Object.keys(module)).toEqual(["LegalWorkSkillTools"]);
    const hooks = [];
    for (const initialize of new Set(Object.values(module))) {
      if (typeof initialize !== "function") throw new Error("Plugin export is not a function");
      hooks.push(await initialize({ directory, worktree: directory, client: {}, project: {} }, {}));
    }
    expect(hooks).toHaveLength(1);
    expect(Object.keys(hooks[0].tool)).toEqual(["legalwork_skill_create", "legalwork_skill_list"]);
    const output = { system: [] };
    await hooks[0]["experimental.chat.system.transform"]({}, output);
    expect(output.system.join("\n")).toContain("legalwork_skill_create");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
