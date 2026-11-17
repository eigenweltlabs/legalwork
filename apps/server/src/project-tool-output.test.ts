import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { saveProjectToolOutput } from "./project-tool-output.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await realpath(await mkdtemp(join(tmpdir(), "project-tool-output-"))); roots.push(root); return root; }

test("large shell envelopes save complete readable stdout and keep command metadata", async () => {
  const root = await project(), stdout = "Paragraph with real line breaks.\n".repeat(4000) + "FINAL EVIDENCE";
  const envelope = { output: stdout, exitCode: 7, truncated: false, sandbox: "host", signal: "SIGTERM" };
  const saved = await saveProjectToolOutput(root, "ses_first", "call_first", { content: JSON.stringify(envelope), output: envelope, metadata: { title: "Read sources" } });
  expect(saved).toBeDefined();
  const path = z.string().parse(saved?.metadata?.outputPath);
  expect(path).toBe(join(root, ".legalwork", "tool-output", "ses_first", "call_first.txt"));
  expect(await readFile(path, "utf8")).toBe(stdout);
  expect(saved?.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Paragraph with real line breaks.\n") })]));
  expect(saved?.metadata).toMatchObject({ title: "Read sources", exitCode: 7, sandbox: "host", signal: "SIGTERM", truncated: true, sourceTruncated: false });
  expect(saved?.output).toBe(envelope);
  expect(await readFile(path, "utf8")).toContain("FINAL EVIDENCE");
});

test("structured connector output is complete formatted JSON, keeping media content", async () => {
  const root = await project(), data = { padding: "x".repeat(80000), evidence: "searchable evidence" };
  const image = { type: "file", mime: "image/png", uri: "data:image/png;base64,aW1hZ2U=" };
  const saved = await saveProjectToolOutput(root, "ses_json", "call_json", { content: [{ type: "text", text: JSON.stringify(data) }, { type: "file", mime: image.mime, uri: image.uri }] });
  const path = z.string().parse(saved?.metadata?.outputPath);
  expect(path.endsWith(".json")).toBe(true);
  const content = await readFile(path, "utf8");
  expect(JSON.parse(content)).toEqual(data);
  expect(content).toContain('\n  "evidence": "searchable evidence"');
  expect(saved?.content).toEqual(expect.arrayContaining([image]));
});

test("small results do not create storage; UTF-8 previews preserve full retained bytes", async () => {
  const root = await project();
  expect(await saveProjectToolOutput(root, "ses_small", "call_small", { content: "small result" })).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
  const text = "§😀é".repeat(16000);
  const saved = await saveProjectToolOutput(root, "ses_utf8", "call_utf8", { content: text });
  expect(JSON.stringify(saved?.content)).not.toContain("�");
  expect(await readFile(z.string().parse(saved?.metadata?.outputPath), "utf8")).toBe(text);
});

test("reused call IDs preserve earlier results and redirected directories are rejected", async () => {
  const root = await project();
  const first = await saveProjectToolOutput(root, "ses_collision", "call_reused", { content: "a".repeat(60000) });
  const second = await saveProjectToolOutput(root, "ses_collision", "call_reused", { content: "b".repeat(60000) });
  const a = z.string().parse(first?.metadata?.outputPath), b = z.string().parse(second?.metadata?.outputPath);
  expect(a).not.toBe(b); expect(await readFile(a, "utf8")).toBe("a".repeat(60000)); expect(await readFile(b, "utf8")).toBe("b".repeat(60000));
  const outside = await project(), redirected = await project();
  await symlink(outside, join(redirected, ".legalwork"));
  await expect(saveProjectToolOutput(redirected, "ses_redirect", "call_redirect", { content: "c".repeat(60000) })).rejects.toThrow("ordinary project directory");
  expect(await readdir(outside)).toEqual([]);
  await mkdir(join(root, ".legalwork", "tool-output", "ses_safe"));
  const safe = await saveProjectToolOutput(root, "../ses/escape", "../../escape", { content: "d".repeat(60000) });
  expect(z.string().parse(safe?.metadata?.outputPath).startsWith(join(root, ".legalwork", "tool-output") + "/")).toBe(true);
});
