import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { coreManifest, rememberCoreManifest, unchangedCoreSkill } from "./core-bundle.js";
import { listSkills, upsertSkill } from "./skills.js";
import { listSkillResources, resolveSkillDir, upsertSkillResource } from "./skill-resources.js";
import { serializeWorkflowSkill } from "./eigenwelt-hub.js";
import { CORE_OPENCODE_FILES } from "./core-skills.js";

const skill = (body: string) => `---\nname: docx-edit\ndescription: Edit Word documents\n---\n${body}\n`;

test("unchanged legacy development research selects current persistence guidance, while edited packages remain project-owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-legacy-research-"));
  const project = join(root, "project"), library = join(root, "library"), relative = ".opencode/skills/legal-research/SKILL.md";
  try {
    const original = await readFile(new URL("./wiki/fixtures/legal-research-skill-alpha167.md", import.meta.url), "utf8");
    const current = CORE_OPENCODE_FILES.find(file => file.path === relative)!;
    for (const base of [project, library]) await mkdir(dirname(join(base, relative)), { recursive: true });
    await writeFile(join(project, relative), original);
    await writeFile(join(project, ".opencode/.legalwork-core"), "7cae87135b7adebe6e7e31629b021b67b96e92fc");
    await writeFile(join(library, relative), current.content);
    expect(await unchangedCoreSkill(project, join(project, relative), library)).toBe(true);
    expect(await readFile(join(project, relative), "utf8")).toBe(original);
    await writeFile(join(project, relative), original + "\nMy project-specific research preference.\n");
    expect(await unchangedCoreSkill(project, join(project, relative), library)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
async function fixture(run: (project: string, library: string, path: string, original: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-core-selection-"));
  const project = join(root, "project"), library = join(root, "library"), path = join(project, ".opencode/skills/docx-edit/SKILL.md");
  const files = [{ path: ".opencode/skills/docx-edit/SKILL.md", content: skill("Old bundled instructions") },
    { path: ".opencode/skills/docx-edit/assets/helper.mjs", content: "old helper\n" }];
  try {
    await mkdir(join(project, ".git"), { recursive: true });
    for (const file of files) { await mkdir(dirname(join(project, file.path)), { recursive: true }); await writeFile(join(project, file.path), file.content); }
    const manifest = coreManifest(files);
    await writeFile(join(project, ".opencode/.legalwork-core"), manifest.bundle);
    await rememberCoreManifest(library, manifest);
    await mkdir(join(library, ".opencode/skills/docx-edit"), { recursive: true });
    await writeFile(join(library, ".opencode/skills/docx-edit/SKILL.md"), skill("Updated shared instructions"));
    await run(project, library, path, files[0]!.content);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("unchanged old packages select updated shared instructions in both UI listing modes without modifying files", () => fixture(async (project, library, path, original) => {
  expect(await unchangedCoreSkill(project, path, library)).toBe(true);
  for (const personal of [false, true]) {
    const selected = (await listSkills(project, personal, undefined, library)).find(skill => skill.name === "docx-edit");
    expect(selected?.path).toBe(join(library, ".opencode/skills/docx-edit/SKILL.md"));
    expect(selected?.scope).toBe("global");
    expect(await readFile(selected!.path, "utf8")).toContain("Updated shared instructions");
  }
  expect(await readFile(path, "utf8")).toBe(original);
}));

test("an edited instruction or helper, extra resource or missing asset preserves the whole project package", async () => {
  for (const change of ["instructions", "helper", "extra", "missing"]) await fixture(async (project, library, path) => {
    expect(await unchangedCoreSkill(project, path, library)).toBe(true);
    const helper = join(dirname(path), "assets/helper.mjs");
    if (change === "instructions") await writeFile(path, skill("My project instructions"));
    if (change === "helper") await writeFile(helper, "my helper\n");
    if (change === "extra") await writeFile(join(dirname(path), "template.txt"), "my template");
    if (change === "missing") await rm(helper);
    expect(await unchangedCoreSkill(project, path, library)).toBe(false);
    expect((await listSkills(project, true, undefined, library)).find(skill => skill.name === "docx-edit")?.path).toBe(path);
  });
});

test("unknown or unreadable bundle receipts never discard a project override", async () => {
  for (const receipt of ["unknown-version", "1".repeat(40), "malformed"]) await fixture(async (project, library, path) => {
    await writeFile(join(project, ".opencode/.legalwork-core"), receipt);
    expect(await unchangedCoreSkill(project, path, library)).toBe(false);
    expect((await listSkills(project, true, undefined, library)).find(skill => skill.name === "docx-edit")?.path).toBe(path);
  });
});

test("linked package contents preserve their existing project selection", () => fixture(async (project, library, path) => {
  const helper = join(dirname(path), "assets/helper.mjs"), linked = join(library, "custom-helper.mjs");
  await writeFile(linked, "my linked helper"); await rm(helper); await symlink(linked, helper);
  expect(await unchangedCoreSkill(project, path, library)).toBe(false);
}));

test("a project package remains available when the shared replacement is missing", () => fixture(async (project, library, path) => {
  await rm(join(library, ".opencode/skills/docx-edit"), { recursive: true });
  expect(await unchangedCoreSkill(project, path, library)).toBe(false);
  expect((await listSkills(project, true, undefined, library)).find(skill => skill.name === "docx-edit")?.path).toBe(path);
}));

test("package reads and sharing follow the selected version and cannot mutate the private bundle", () => fixture(async (project, library, path, original) => {
  const shared = join(library, ".opencode/skills/docx-edit");
  expect(await resolveSkillDir(project, "docx-edit", library)).toBe(shared);
  expect(await listSkillResources(project, "docx-edit", library)).toEqual([]);
  const payload = await serializeWorkflowSkill(project, "docx-edit", library);
  expect(Buffer.from(payload.files.find(file => file.path === "SKILL.md")!.contentBase64, "base64").toString()).toContain("Updated shared instructions");
  await expect(upsertSkillResource(project, "docx-edit", { name: "template.txt", content: "custom" }, library)).rejects.toMatchObject({ code: "bundled_skill_read_only" });
  expect(await readFile(path, "utf8")).toBe(original);
  await writeFile(path, skill("My custom instructions"));
  await upsertSkillResource(project, "docx-edit", { name: "template.txt", content: "custom" }, library);
  expect((await listSkillResources(project, "docx-edit", library))[0]?.path).toBe(join(project, ".opencode/skills/docx-edit/resources/template.txt"));
}));

test("an explicit bundled-skill edit creates a complete custom override without changing the shared package", () => fixture(async (project, library, path) => {
  const shared = join(library, ".opencode/skills/docx-edit"), helper = join(shared, "assets/current-helper.mjs");
  await mkdir(dirname(helper)); await writeFile(helper, "current helper");
  const original = await readFile(join(shared, "SKILL.md"), "utf8");
  await upsertSkill(project, { name: "docx-edit", content: "My custom Word instructions", description: "Custom Word helper" }, library);
  expect(await readFile(path, "utf8")).toContain("My custom Word instructions");
  expect(await readFile(join(dirname(path), "assets/current-helper.mjs"), "utf8")).toBe("current helper");
  expect(await readFile(join(shared, "SKILL.md"), "utf8")).toBe(original);
  expect((await listSkills(project, false, undefined, library)).find(item => item.name === "docx-edit")?.path).toBe(path);
}));
