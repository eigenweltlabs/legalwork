import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("only an installed standard skill with the tested executable can calculate", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-skill-test-"));
  const source = new URL("./skills.ts", import.meta.url).href;
  const script = join(root, "check.mjs");
  await writeFile(script, `
    import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import assert from "node:assert/strict";
    const { ensureDeadlineSkills, calculateWithSkill } = await import(${JSON.stringify(source)});
    const project = join(process.env.XDG_CONFIG_HOME, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    const name = "de-civil-deadlines", dir = join(process.env.XDG_CONFIG_HOME, "opencode", "skills", name);
    const input = { rule: "de-zpo-period", triggerDate: "2026-01-31", duration: 1, unit: "months", region: "NW", source: "Court service record" };
    await ensureDeadlineSkills();
    assert.equal((await calculateWithSkill(project, name, input)).deadlineDay, "2026-03-02");
    const code = await readFile(join(dir, "calculate.mjs"), "utf8");
    await writeFile(join(dir, "calculate.mjs"), code + "\\n// modified");
    await assert.rejects(calculateWithSkill(project, name, input), { code: "deadline_code_unreviewed" });
    await rm(join(dir, "calculate.mjs"));
    await assert.rejects(calculateWithSkill(project, name, input), { code: "deadline_code_missing" });
    await writeFile(join(dir, "calculate.mjs"), code);
    await assert.rejects(calculateWithSkill(project, name, { ...input, rule: "de-tax-limitations" }), { code: "unsupported_rule" });
    const shadow = join(project, ".opencode", "skills", name);
    await mkdir(shadow, { recursive: true });
    await writeFile(join(shadow, "SKILL.md"), "---\\nname: " + name + "\\ndescription: A user-facing calculation skill.\\nkind: workflow\\n---\\n");
    await assert.rejects(calculateWithSkill(project, name, input), { code: "deadline_code_missing" });
    await writeFile(join(shadow, "calculate.mjs"), code);
    assert.equal((await calculateWithSkill(project, name, input)).deadlineDay, "2026-03-02");
    await writeFile(join(shadow, "calculate.mjs"), code + "\\n// modified workflow code");
    await assert.rejects(calculateWithSkill(project, name, input), { code: "deadline_code_unreviewed" });
    await rm(shadow, { recursive: true });
    await rm(join(dir, "SKILL.md"));
    await ensureDeadlineSkills();
    await assert.rejects(calculateWithSkill(project, name, input), { code: "deadline_skill_missing" });
    console.log("installed, executable, tamper, missing code, unsupported rule, workflow shadow, and deletion checks passed");
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("deletion checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
