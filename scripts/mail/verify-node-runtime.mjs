import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Synthetic headless acceptance, using only installation workers and native packages. */
export async function verifyMailNodeRuntime({ executable, directory, nativeDirectory, expectedArch }) {
  const root = await mkdtemp(join(tmpdir(), "mail-node-acceptance-"));
  const env = {};
  for (const name of ["SystemRoot", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
  function run(entry, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [entry], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "", stderr = "", failed = false;
      const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 100_000);
      child.on("error", () => { failed = true; }); child.stdin.on("error", () => {});
      child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 1024 * 1024) { failed = true; child.kill("SIGKILL"); } });
      child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 4096) { failed = true; child.kill("SIGKILL"); } });
      child.on("close", code => {
        clearTimeout(timer);
        const secrets = [input.encryptionKey, input.sourceKey, input.destinationKey].filter(value => typeof value === "string");
        if (failed || secrets.some(value => stdout.includes(value) || stderr.includes(value))) reject(Error("mail_node_probe_failed"));
        else resolve({ code, stdout, stderr });
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  async function worker(initialization, action) {
    const child = spawn(executable, [join(directory, "worker.mjs")], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "", sequence = 0, stderrBytes = 0;
    const pending = new Map();
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let exitResolve;
    const exited = new Promise(resolve => { exitResolve = resolve; });
    const fail = () => {
      readyReject(Error("mail_node_worker_failed"));
      for (const value of pending.values()) value.reject(Error("mail_node_worker_failed"));
      pending.clear(); child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, 60_000);
    child.on("error", fail); child.stdin.on("error", fail);
    child.stderr.on("data", bytes => { stderrBytes += bytes.length; if (stderrBytes > 4096) fail(); });
    child.stdout.on("data", bytes => {
      buffer += bytes;
      try {
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          assert.ok(newline <= 65536);
          const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
          if (message.kind === "ready") { assert.equal(message.runtime, "node"); readyResolve(message); }
          else if (message.kind === "fatal") readyReject(Error(message.code));
          else {
            const request = pending.get(message.id); assert.ok(request); pending.delete(message.id);
            if (message.ok) request.resolve(message.result); else request.reject(Error("mail_node_command_failed"));
          }
        }
        if (buffer.length > 65536) fail();
      } catch { fail(); }
    });
    child.on("close", code => { exitResolve(code); if (pending.size) fail(); readyReject(Error("mail_node_worker_exited")); });
    const request = command => new Promise((resolve, reject) => {
      const id = `1:${++sequence}`; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ kind: "request", id, command }) + "\n");
    });
    try {
      child.stdin.write(JSON.stringify({ kind: "initialize", protocol: 1, initialization }) + "\n");
      const evidence = await ready;
      const result = await action(request, evidence);
      child.stdin.end(JSON.stringify({ kind: "shutdown" }) + "\n");
      assert.equal(await exited, 0); return result;
    } finally {
      child.kill("SIGKILL"); await exited; clearTimeout(timer);
    }
  }
  try {
    const original = { ownerId: "synthetic-package-owner", databasePath: join(root, "mail.sqlite"), encryptionKey: randomBytes(32).toString("base64") };
    await writeFile(original.databasePath, "", { mode: 0o600, flag: "wx" });
    const inspection = join(root, "inspection.mjs");
    await writeFile(inspection, `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(nativeDirectory, "package.json"))});
const Database = require(${JSON.stringify(nativeDirectory)});
const input = JSON.parse(readFileSync(0, 'utf8'));
const db = new Database(input.databasePath), key = Buffer.from(input.encryptionKey, 'base64');
try {
 db.pragma("cipher='sqlcipher'"); db.pragma('legacy=0'); db.pragma('temp_store=MEMORY'); db.key(key);
 db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS packaging_fts USING fts5(text)');
 if (!db.prepare('SELECT rowid FROM packaging_fts').get()) db.prepare('INSERT INTO packaging_fts(text) VALUES (?)').run('synthetic_packaging_private_marker');
 const binding = require(${JSON.stringify(join(nativeDirectory, "lib/binding.js"))});
 console.log(JSON.stringify({node:process.versions.node, electron:process.versions.electron ?? null, arch:process.arch,
  engine:db.prepare('SELECT sqlite3mc_version() AS v').get().v, cipher:db.pragma('cipher',{simple:true}),
  count:db.prepare("SELECT count(*) AS n FROM packaging_fts WHERE packaging_fts MATCH 'synthetic_packaging_private_marker'").get().n,
  native:binding.getPrebuildPath()}));
} finally { key.fill(0); db.close(); }
`);
    let evidence;
    const inspect = async initialization => {
      const result = await run(inspection, initialization); assert.equal(result.code, 0, result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.arch, expectedArch); assert.equal(value.electron, null);
      assert.ok(Number(value.node.split(".")[0]) >= 22); assert.equal(value.count, 1);
      assert.equal(value.engine, "SQLite3 Multiple Ciphers 2.4.0"); assert.equal(value.cipher, "sqlcipher");
      assert.ok(value.native.startsWith(nativeDirectory));
      assert.ok(value.native.endsWith(`${process.platform}-${expectedArch}.node`)); return value;
    };
    evidence = await inspect(original);
    const source = join(root, "message.eml");
    await writeFile(source, ["From: synthetic@example.test", "Subject: Packaged MIME", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="packaged"', "", "--packaged", "Content-Type: text/plain; charset=utf-8", "", "Packagedbodyneedle", "--packaged", "Content-Type: text/plain; charset=utf-8", 'Content-Disposition: attachment; filename="contract.txt"', "", "Packagedattachmentneedle", "--packaged--", ""].join("\r\n"));
    const waitFor = async (read, check) => {
      for (let attempt = 0; attempt < 200; attempt++) { const result = await read(); if (check(result)) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw Error("mail_node_index_did_not_complete");
    };
    await worker(original, async (request, ready) => {
      assert.equal(ready.nodeVersion, evidence.node);
      assert.equal((await request({ operation: "mail.storage.status" })).encrypted, true);
      assert.equal((await request({ operation: "mail.search", input: {} })).search.total, 0);
      await request({ operation: "mail.portability.import", path: source, format: "eml", label: "Synthetic packaged archive" });
      await waitFor(() => request({ operation: "mail.portability.list" }), result => result.portability?.[0]?.state === "complete");
      for (const keyword of ["Packagedbodyneedle", "Packagedattachmentneedle"]) {
        const result = await waitFor(() => request({ operation: "mail.search", input: { keywords: [keyword] } }), value => value.search.total === 1);
        assert.equal(result.search.total, 1);
      }
    });
    await worker(original, async request => { assert.equal((await request({ operation: "mail.search", input: { keywords: ["Packagedattachmentneedle"] } })).search.total, 1); });
    await worker({ ...original, ownerId: "synthetic-foreign-owner" }, async request => {
      assert.deepEqual((await request({ operation: "mail.accounts.list" })).accounts, []);
      assert.equal((await request({ operation: "mail.search", input: { keywords: ["Packagedbodyneedle"] } })).search.total, 0);
    });
    await inspect(original);
    const rotatedDirectory = join(root, "rotated"); await mkdir(rotatedDirectory, { mode: 0o700 });
    const rotated = { ...original, databasePath: join(rotatedDirectory, "mail.sqlite"), encryptionKey: randomBytes(32).toString("base64") };
    const rotation = await run(join(directory, "maintenance-worker.mjs"), { sourcePath: original.databasePath, destinationPath: rotated.databasePath, sourceKey: original.encryptionKey, destinationKey: rotated.encryptionKey, ownerId: original.ownerId, restore: false, expectedSha256: null });
    assert.equal(rotation.code, 0, rotation.stderr); assert.equal(JSON.parse(rotation.stdout).ok, true);
    await inspect(rotated);
    await worker(rotated, async request => { assert.equal((await request({ operation: "mail.search", input: { keywords: ["Packagedattachmentneedle"] } })).search.total, 1); });
    await assert.rejects(worker({ ...rotated, encryptionKey: original.encryptionKey }, async () => {}), /initialization_failed/);
    // Build a small PDF without using a development parser or font dependency.
    const content = "BT /F1 24 Tf 20 100 Td (Packagedpdfneedle) Tj ET";
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let pdf = "%PDF-1.4\n", offsets = [0];
    for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const extract = async (bytes, filename, contentType, marker) => {
      const result = await run(join(directory, "process.js"), { data: Buffer.from(bytes).toString("base64"), filename, contentType });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout); assert.equal(parsed.ok, true, parsed.error);
      assert.ok(parsed.result.sections.some(section => section.text.includes(marker))); return parsed.result;
    };
    await extract(Buffer.from(pdf), "contract.pdf", "application/pdf", "Packagedpdfneedle");
    const imageFixture = join(root, "image-fixture.mjs");
    await writeFile(imageFixture, `
import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(join(directory, "worker.mjs"))});
const {createCanvas}=require('@napi-rs/canvas');
const canvas=createCanvas(1000,220),context=canvas.getContext('2d');
context.fillStyle='white';context.fillRect(0,0,1000,220);context.fillStyle='black';
context.font='60px Arial';context.fillText('CONTRACT ATTACHMENT 138',20,125);
console.log(JSON.stringify({data:canvas.toBuffer('image/png').toString('base64')}));
`);
    const fixture = await run(imageFixture, {}); assert.equal(fixture.code, 0, fixture.stderr);
    const ocr = await extract(Buffer.from(JSON.parse(fixture.stdout).data, "base64"), "scan.png", "image/png", "CONTRACT ATTACHMENT 138");
    assert.ok(ocr.sections.some(section => section.method === "ocr"));
    const ciphertext = await readFile(original.databasePath);
    assert.notEqual(ciphertext.subarray(0, 16).toString(), "SQLite format 3\0");
    for (const marker of ["synthetic_packaging_private_marker", "Packagedbodyneedle", "Packagedattachmentneedle"]) assert.equal(ciphertext.includes(Buffer.from(marker)), false);
    return { passed: true, platform: process.platform, arch: evidence.arch, node: evidence.node,
      checks: ["bundled-node", "encrypted-FTS", "MIME", "attachment-subprocess-indexing", "owner-isolation", "offline-PDF", "offline-OCR", "worker-status-search", "reopen", "rotation", "wrong-key-refusal", "ciphertext-marker-absence"] };
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
