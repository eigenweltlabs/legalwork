// Inspect the shipped binary, not just the builder configuration.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { getCurrentFuseWire, FuseV1Options } = libRequire("@electron/fuses");
const target = process.argv[2];
if (!target) throw new Error("Usage: pnpm check:packaged-security <packaged .app or executable>");
const appPath = path.resolve(target);
const wire = await getCurrentFuseWire(appPath);
for (const [name, enabled] of Object.entries({
  RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true,
})) {
  assert.equal(wire[FuseV1Options[name]], enabled ? 49 : 48, `${name} has the wrong packaged fuse value`);
  console.log(`PASS: ${name}=${enabled}`);
}
const resources = process.platform === "darwin" ? path.join(appPath, "Contents/Resources") : path.join(path.dirname(appPath), "resources");
const nodeDirectory = path.join(resources, "node");
const metadata = JSON.parse(await readFile(path.join(nodeDirectory, "runtime.json"), "utf8"));
const expectedArch = metadata.source.target.split("-").at(-1);
const node = spawnSync("node", ["-p", "JSON.stringify({version:process.versions.node,electron:process.versions.electron??null,arch:process.arch})"], {
  env: { ...process.env, PATH: nodeDirectory, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" }, encoding: "utf8",
});
if (node.error) throw node.error;
assert.equal(node.status, 0, node.stderr);
assert.deepEqual(JSON.parse(node.stdout), { version: metadata.source.version, electron: null, arch: expectedArch });
console.log(`PASS: bundled Node ${metadata.source.version} runs with no system Node on PATH`);
if (process.platform === "win32") {
  const expectedMachine = expectedArch === "arm64" ? 0xaa64 : 0x8664;
  for (const executable of [appPath, path.join(nodeDirectory, "node.exe"), path.join(resources, "sidecars/opencode.exe")]) {
    const file = await open(executable, "r");
    try {
      const header = Buffer.alloc(64);
      await file.read(header, 0, header.length, 0);
      assert.equal(header.readUInt16LE(0), 0x5a4d, `${executable} must be a PE executable`);
      const pe = Buffer.alloc(6);
      await file.read(pe, 0, pe.length, header.readUInt32LE(60));
      assert.equal(pe.readUInt32LE(0), 0x4550);
      assert.equal(pe.readUInt16LE(4), expectedMachine, `${executable} must match the ${expectedArch} installer`);
    } finally { await file.close(); }
  }
  console.log(`PASS: Windows app, Node and engine are all ${expectedArch}`);
  const speech = spawnSync(path.join(nodeDirectory, "node.exe"), ["-e", "const s=require(process.argv[1]); if(typeof s.OfflineRecognizer.createAsync !== 'function' || typeof s.Vad !== 'function') process.exit(1); console.log(s.version)", path.join(resources, "app.asar.unpacked/node_modules/sherpa-onnx-node")], {
    env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" }, encoding: "utf8", timeout: 30_000,
  });
  if (speech.error) throw speech.error;
  assert.equal(speech.status, 0, speech.stderr);
  console.log(`PASS: packaged ${expectedArch} speech addon loads with bundled Node (${speech.stdout.trim()})`);
}
if (process.platform === "linux") console.log("NOTE: Electron does not enforce ASAR integrity on Linux; the other fuse restrictions apply.");

// Exercise the document tools extracted from the shipped archive with only the
// shipped Node on PATH, so a developer's installation cannot hide a missing dependency.
const temporary = await mkdtemp(path.join(tmpdir(), "legalwork-packaged-tools-"));
try {
  const { extractFile } = libRequire("@electron/asar");
  const core = extractFile(path.join(resources, "app.asar"), path.join("server", "dist", "core-skills.js"));
  const { CORE_OPENCODE_FILES } = await import(`data:text/javascript;base64,${core.toString("base64")}`);
  for (const file of CORE_OPENCODE_FILES.filter((entry) => /\/skills\/(docx-edit|pdf-tools)\//.test(entry.path))) {
    const destination = path.join(temporary, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const env = { ...process.env, PATH: nodeDirectory, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" };
  const runNode = (args, input) => {
    const result = spawnSync("node", args, { cwd: temporary, env, input, encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const fixture = fileURLToPath(new URL("../../app/scripts/fixtures/legal-review.docx", import.meta.url));
  await copyFile(fixture, path.join(temporary, "source.docx"));
  const docx = ".opencode/skills/docx-edit/assets/docx-agent.mjs";
  const original = JSON.parse(runNode([docx, "inspect", "source.docx"]));
  const paragraph = original.paragraphs.find((entry) => entry.text.includes("Services Agreement"));
  assert.ok(paragraph, "DOCX inspection must find the fixture title");
  const edited = JSON.parse(runNode([docx, "apply", "source.docx", "--plan", "-"], JSON.stringify({
    proposals: [{ paragraphIndex: paragraph.index, search: "Services Agreement", replaceWith: "Security Package Test" }],
  })));
  assert.equal(edited.ok, true);
  assert.equal(edited.proposalsAdded, 1);
  assert.deepEqual(edited.errors, []);
  JSON.parse(runNode([docx, "inspect", edited.out]));
  console.log("PASS: packaged Word tool reads, edits and reopens DOCX with bundled Node");
  runNode(["--input-type=module", "-e", `import {writeFile} from 'node:fs/promises'; import {PDFDocument} from './.opencode/skills/pdf-tools/assets/vendor/pdf-lib.mjs'; const pdf=await PDFDocument.create(); pdf.addPage().drawText('Security package test'); await writeFile('source.pdf',await pdf.save());`]);
  const pdf = JSON.parse(runNode([".opencode/skills/pdf-tools/assets/pdf-agent.mjs", "inspect", "source.pdf"]));
  assert.equal(pdf.pageCount, 1);
  console.log("PASS: packaged PDF tool reads a PDF with bundled Node");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
