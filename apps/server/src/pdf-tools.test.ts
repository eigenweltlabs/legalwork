import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";

import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { parseFrontmatter } from "./frontmatter.js";
import { listCommands } from "./commands.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";

const PDF_COMMANDS = ["open", "annotate", "fill-form", "sign"];

const PDF_SKILL_FILES = [
  ".opencode/skills/pdf-tools/SKILL.md",
  ".opencode/skills/pdf-tools/assets/pdf-agent.mjs",
  ".opencode/skills/pdf-tools/assets/pdf-ops.mjs",
  ".opencode/skills/pdf-tools/assets/pdf-text.mjs",
  ".opencode/skills/pdf-tools/assets/vendor/pdf-lib.mjs",
];

function bundledFile(path: string) {
  const file = CORE_OPENCODE_FILES.find((f) => f.path === path);
  if (!file) throw new Error(`expected ${path} in CORE_OPENCODE_FILES — run: node scripts/gen-core-skills.mjs`);
  return file;
}

describe("pdf-tools bundle", () => {
  test("skill files are bundled into core-skills", () => {
    const paths = CORE_OPENCODE_FILES.map((f) => f.path);
    for (const path of PDF_SKILL_FILES) expect(paths).toContain(path);

    const skill = parseFrontmatter(bundledFile(".opencode/skills/pdf-tools/SKILL.md").content);
    expect(skill.data.name).toBe("pdf-tools");
    expect(typeof skill.data.description).toBe("string");
    // The SKILL must document the exact script invocation the agent runs.
    expect(skill.body).toContain(".opencode/skills/pdf-tools/assets/pdf-agent.mjs");
  });

  test("the four PDF commands are bundled with a description and $ARGUMENTS", () => {
    for (const name of PDF_COMMANDS) {
      const { data, body } = parseFrontmatter(bundledFile(`.opencode/commands/${name}.md`).content);
      expect(typeof data.description).toBe("string");
      expect(String(data.description).length).toBeGreaterThan(0);
      expect(body).toContain("$ARGUMENTS");
    }
  });
});

// ---------- functional: run the bundled pdf-agent script on a real PDF ----------

const inspectResult = z.object({
  pageCount: z.number(),
  pages: z.array(z.object({ page: z.number(), width: z.number(), height: z.number() })),
  fields: z.array(z.looseObject({ name: z.string(), type: z.string() })),
});

const fillResult = z.object({
  ok: z.boolean(),
  out: z.string(),
  name: z.string(),
  filled: z.array(z.string()),
  skipped: z.array(z.object({ field: z.string(), reason: z.string() })),
});

const annotateResult = z.object({ ok: z.boolean(), name: z.string(), notes: z.number(), highlights: z.number() });

const textResult = z.object({
  pageCount: z.number(),
  pages: z.array(z.object({ page: z.number(), text: z.string() })),
});

const signResult = z.object({ ok: z.boolean(), name: z.string(), page: z.number(), x: z.number(), y: z.number() });

// 1x1 red PNG — the smallest valid signature image.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("pdf-agent script", () => {
  let workspace: string;
  let agentScript: string;
  let samplePath: string;
  let sampleBytes: Buffer;

  function runAgent(args: string[], input?: string): string {
    return execFileSync("node", [agentScript, ...args], { input, encoding: "utf8", cwd: workspace });
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "legalwork-pdf-tools-"));
    // Seed the workspace exactly the way the app does, then run the seeded script.
    await ensureWorkspaceFiles(workspace, "starter");
    agentScript = join(workspace, ".opencode", "skills", "pdf-tools", "assets", "pdf-agent.mjs");

    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    form.createTextField("client.name").addToPage(page, { x: 72, y: 700, width: 200, height: 18 });
    form.createCheckBox("client.agrees").addToPage(page, { x: 72, y: 660, width: 14, height: 14 });
    const state = form.createDropdown("client.state");
    state.addOptions(["CA", "NY"]);
    state.addToPage(page, { x: 72, y: 620, width: 80, height: 18 });
    samplePath = join(workspace, "sample.pdf");
    await writeFile(samplePath, await doc.save());
    sampleBytes = await readFile(samplePath);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("workspace seeding surfaces the four PDF commands", async () => {
    const names = (await listCommands(workspace, "workspace")).map((c) => c.name);
    for (const name of PDF_COMMANDS) expect(names).toContain(name);
  });

  test("inspect reports page sizes and form fields", () => {
    const result = inspectResult.parse(JSON.parse(runAgent(["inspect", samplePath])));
    expect(result.pageCount).toBe(1);
    expect(result.pages).toEqual([{ page: 1, width: 612, height: 792 }]);
    expect(result.fields.map((f) => `${f.name}:${f.type}`).sort()).toEqual([
      "client.agrees:checkbox",
      "client.name:text",
      "client.state:dropdown",
    ]);
  });

  test("text extracts per-page text content", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText("The annual salary shall be EUR 55,000.00.", { x: 72, y: 700, size: 11, font });
    doc.addPage([612, 792]).drawText("Governing law: Germany.", { x: 72, y: 700, size: 11, font });
    const textPath = join(workspace, "text-sample.pdf");
    await writeFile(textPath, await doc.save());

    const result = textResult.parse(JSON.parse(runAgent(["text", textPath])));
    expect(result.pageCount).toBe(2);
    expect(result.pages[0]?.text).toContain("EUR 55,000.00");
    expect(result.pages[1]?.text).toContain("Governing law: Germany.");

    const single = textResult.parse(JSON.parse(runAgent(["text", textPath, "--pages", "2"])));
    expect(single.pages.map((p) => p.page)).toEqual([2]);
  });

  test("fill writes <name>.filled.pdf with the values and reports skips", async () => {
    const data = { "client.name": "Jane Doe", "client.agrees": true, "client.state": "NY", "missing.field": "x" };
    const result = fillResult.parse(JSON.parse(runAgent(["fill", samplePath, "--data", "-"], JSON.stringify(data))));

    expect(result.name).toBe("sample.filled.pdf");
    expect(result.filled.sort()).toEqual(["client.agrees", "client.name", "client.state"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.field).toBe("missing.field");
    expect(result.ok).toBe(false); // a skip means not fully ok

    const filled = await PDFDocument.load(await readFile(join(workspace, "sample.filled.pdf")));
    const form = filled.getForm();
    expect(form.getTextField("client.name").getText()).toBe("Jane Doe");
    expect(form.getCheckBox("client.agrees").isChecked()).toBe(true);
    expect(form.getDropdown("client.state").getSelected()).toEqual(["NY"]);
    // the source PDF is untouched
    expect((await readFile(samplePath)).equals(sampleBytes)).toBe(true);
  });

  test("fill rejects an invalid dropdown option with the valid options in the reason", () => {
    const result = fillResult.parse(
      JSON.parse(runAgent(["fill", samplePath, "--data", "-"], JSON.stringify({ "client.state": "TX" }))),
    );
    expect(result.filled).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("CA, NY");
  });

  test("annotate writes <name>.annotated.pdf with notes and highlights", async () => {
    const plan = {
      annotations: [
        { type: "note", page: 1, x: 320, y: 640, text: "Please double-check the state selection." },
        { type: "highlight", page: 1, x: 70, y: 695, width: 210, height: 26 },
      ],
    };
    const result = annotateResult.parse(JSON.parse(runAgent(["annotate", samplePath, "--plan", "-"], JSON.stringify(plan))));
    expect(result).toMatchObject({ ok: true, name: "sample.annotated.pdf", notes: 1, highlights: 1 });

    const annotated = await readFile(join(workspace, "sample.annotated.pdf"));
    expect(annotated.equals(sampleBytes)).toBe(false);
    await expect(PDFDocument.load(annotated)).resolves.toBeDefined(); // still a valid PDF
    expect((await readFile(samplePath)).equals(sampleBytes)).toBe(true);
  });

  test("annotate rejects an out-of-range page instead of writing a file", () => {
    const plan = { annotations: [{ type: "note", page: 5, x: 10, y: 10, text: "hi" }] };
    expect(() => runAgent(["annotate", samplePath, "--plan", "-"], JSON.stringify(plan))).toThrow();
  });

  test("sign stamps a text signature onto <name>.signed.pdf", async () => {
    const result = signResult.parse(
      JSON.parse(runAgent(["sign", samplePath, "--name", "Jane Doe", "--date", "2026-07-01"])),
    );
    expect(result).toMatchObject({ ok: true, name: "sample.signed.pdf", page: 1 });

    const signed = await readFile(join(workspace, "sample.signed.pdf"));
    expect(signed.equals(sampleBytes)).toBe(false);
    await expect(PDFDocument.load(signed)).resolves.toBeDefined();
    expect((await readFile(samplePath)).equals(sampleBytes)).toBe(true);
  });

  test("sign accepts a PNG signature image and a page/position", async () => {
    const imagePath = join(workspace, "sig.png");
    await writeFile(imagePath, TINY_PNG);
    const result = signResult.parse(
      JSON.parse(
        runAgent(["sign", samplePath, "--name", "Jane Doe", "--image", imagePath, "--page", "1", "--x", "300", "--y", "120", "--out", join(workspace, "sample.signed-image.pdf")]),
      ),
    );
    expect(result).toMatchObject({ ok: true, name: "sample.signed-image.pdf", page: 1, x: 300, y: 120 });
    await expect(PDFDocument.load(await readFile(join(workspace, "sample.signed-image.pdf")))).resolves.toBeDefined();
  });

  test("sign without a name fails", () => {
    expect(() => runAgent(["sign", samplePath])).toThrow();
  });

  test("refuses to overwrite the original PDF via --out", () => {
    expect(() => runAgent(["fill", samplePath, "--data", "-", "--out", samplePath], JSON.stringify({ "client.name": "X" }))).toThrow();
  });
});
