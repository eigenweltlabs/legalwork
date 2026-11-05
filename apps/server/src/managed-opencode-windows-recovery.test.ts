import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Service } from "@opencode/client/service";
import { quarantineForeignWindowsService, type WindowsProcessIdentity } from "./managed-opencode-windows-recovery.js";
import { stopManagedOpencodeService } from "./managed-opencode-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const foreign = { name: "svchost.exe", created: "2026-10-25T21:36:26.164Z" };
const text = JSON.stringify({ pid: 1976, url: "http://127.0.0.1:55773", password: "synthetic-private-registration" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-foreign-registration-")); roots.push(root);
  const file = join(root, "service-legalwork.json"); await writeFile(file, text, { mode: 0o600 });
  const listener = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
  const url = new URL(`http://127.0.0.1:${address.port}`);
  const close = () => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return { root, file, listener, close, input: { file, text, pid: 1976, url, executablePath: "C:\\LegalWork\\opencode.exe" } };
}

test("foreign PID recovery preserves the complete private registration and its permissions; no process is signalled", async () => {
  const f = await fixture(); await f.close(); const before = await stat(f.file); let inspected = 0;
  await quarantineForeignWindowsService(f.input, async () => { inspected++; return foreign; });
  expect(inspected).toBe(2); expect(await readdir(f.root)).toHaveLength(1);
  const name = (await readdir(f.root))[0]; if (!name) throw new Error("Preserved registration missing"); expect(name).toStartWith("service-legalwork.json.stale-");
  expect(await readFile(join(f.root, name), "utf8")).toBe(text);
  expect((await stat(join(f.root, name))).mode).toBe(before.mode);
  expect(await Bun.file(f.file).exists()).toBe(false);
});

for (const name of ["opencode.exe", "OPENCODE.EXE", "custom-engine.exe"]) test(`matching supported engine name ${name} stays blocked`, async () => {
  const f = await fixture(); await f.close();
  await expect(quarantineForeignWindowsService({ ...f.input, executablePath: "C:\\LegalWork\\custom-engine.exe" }, async () => ({ ...foreign, name }))).rejects.toThrow("cannot be safely identified");
  expect(await readFile(f.file, "utf8")).toBe(text); expect(await readdir(f.root)).toEqual(["service-legalwork.json"]);
});

test("an existing listener stays blocked even though authenticated discovery does not identify an engine", async () => {
  const f = await fixture(); let inspected = 0;
  try {
    await expect(quarantineForeignWindowsService(f.input, async () => { inspected++; return foreign; })).rejects.toThrow("still has a listener");
    expect(inspected).toBe(1); expect(await readFile(f.file, "utf8")).toBe(text);
  } finally { await f.close(); }
});

test("a changed PID generation stays blocked and preserves the original registration", async () => {
  const f = await fixture(); await f.close(); let inspected = 0;
  await expect(quarantineForeignWindowsService(f.input, async () => ++inspected === 1 ? foreign : { ...foreign, created: "2026-10-25T21:36:27.164Z" })).rejects.toThrow("changed during recovery");
  expect(await readFile(f.file, "utf8")).toBe(text);
});

test("a changed process image stays blocked", async () => {
  const f = await fixture(); await f.close(); let inspected = 0;
  await expect(quarantineForeignWindowsService(f.input, async () => ++inspected === 1 ? foreign : { ...foreign, name: "other.exe" })).rejects.toThrow("changed during recovery");
  expect(await readFile(f.file, "utf8")).toBe(text);
});

test("concurrent registration replacement is retained rather than quarantined", async () => {
  const f = await fixture(); await f.close(); let inspected = 0;
  const replacement = JSON.stringify({ pid: 2000, url: f.input.url.href, password: "new-synthetic-private-registration" });
  await expect(quarantineForeignWindowsService(f.input, async () => { if (++inspected === 2) await writeFile(f.file, replacement); return foreign; })).rejects.toThrow("changed during recovery");
  expect(await readFile(f.file, "utf8")).toBe(replacement); expect(await readdir(f.root)).toEqual(["service-legalwork.json"]);
});

test("missing, ambiguous or unavailable CIM metadata cannot authorize recovery", async () => {
  const f = await fixture(); await f.close();
  for (const inspect of [async () => ({ ...foreign, name: "" }), async () => ({ ...foreign, created: "invalid" }), async (): Promise<WindowsProcessIdentity> => { throw new Error("CIM access unavailable"); }]) {
    await expect(quarantineForeignWindowsService(f.input, inspect)).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(text);
  }
});

test("no unverified or relative engine path is accepted for foreign PID recovery", async () => {
  const f = await fixture(); await f.close(); let inspected = false;
  await expect(quarantineForeignWindowsService({ ...f.input, executablePath: "opencode.exe" }, async () => { inspected = true; return foreign; })).rejects.toThrow("verified managed engine executable");
  expect(inspected).toBe(false); expect(await readFile(f.file, "utf8")).toBe(text);
});

test("public native discovery rejects a different PID without modifying the registration or stopping its listener", async () => {
  const f = await fixture(); await f.close(); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++; expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:synthetic-private-registration").toString("base64")}`);
    return Response.json({ version: "2.1.4-legalwork.http-policy.3", pid: 9999 });
  } });
  const registration = JSON.stringify({ pid: 1976, version: "2.1.4-legalwork.http-policy.3", url: server.url.href, password: "synthetic-private-registration" });
  await writeFile(f.file, registration);
  try { expect(await Service.discover({ file: f.file })).toBeUndefined(); expect(requests).toBe(1); expect(await readFile(f.file, "utf8")).toBe(registration); }
  finally { server.stop(true); }
});

test("the lifecycle guard cannot stop an alive unverified process or silently replace its registration", async () => {
  const f = await fixture(); await f.close();
  const state = join(f.root, "state"), directory = join(state, "opencode"); await mkdir(directory, { recursive: true });
  const file = join(directory, "service-legalwork.json"), registration = JSON.stringify({ pid: process.pid, url: f.input.url.href, password: "synthetic" });
  await writeFile(file, registration);
  const stop = spyOn(Service, "stop").mockImplementation(async () => { throw new Error("Unverified process must never be stopped"); });
  try {
    await expect(stopManagedOpencodeService({ stateDirectory: state, configDirectory: join(f.root, "config"), executablePath: "C:\\LegalWork\\opencode.exe" })).rejects.toThrow("cannot be verified");
    expect(stop).not.toHaveBeenCalled(); expect(await readFile(file, "utf8")).toBe(registration);
  } finally { stop.mockRestore(); }
});

// Opt-in real Windows regression: the operator first verifies that this is an
// unrelated protected process. Never issue a nonzero signal, even on failure.
test.skipIf(process.platform !== "win32" || !process.env.LEGALWORK_TEST_FOREIGN_PID || !process.env.LEGALWORK_TEST_OPENCODE_BIN)("real Windows EPERM PID recovery uses public CIM and never calls native stop or signals the protected process", async () => {
  const pid = Number(process.env.LEGALWORK_TEST_FOREIGN_PID), executablePath = process.env.LEGALWORK_TEST_OPENCODE_BIN;
  if (!Number.isInteger(pid) || pid <= 0 || !executablePath) throw new Error("Explicit reviewed fixture identity required");
  const f = await fixture(); await f.close();
  const state = join(f.root, "state"), directory = join(state, "opencode"); await mkdir(directory, { recursive: true });
  const file = join(directory, "service-legalwork.json"), registration = JSON.stringify({ pid, url: f.input.url.href, password: "synthetic" });
  await writeFile(file, registration);
  const originalKill = process.kill.bind(process), signals: unknown[] = [];
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    signals.push({ pid: target, signal });
    if (target !== pid || signal !== 0) throw new Error("Fixture forbids any real process signal");
    return originalKill(target, signal);
  });
  const stop = spyOn(Service, "stop").mockImplementation(async () => { throw new Error("Foreign process must never be stopped"); });
  try {
    expect(() => process.kill(pid, 0)).toThrow("EPERM"); signals.length = 0;
    await stopManagedOpencodeService({ stateDirectory: state, configDirectory: join(f.root, "config"), executablePath });
    expect(signals).toEqual([{ pid, signal: 0 }]); expect(stop).not.toHaveBeenCalled();
    const files = await readdir(directory); expect(files).toHaveLength(1); const name = files[0]; if (!name) throw new Error("Preserved registration missing");
    expect(name).toStartWith("service-legalwork.json.stale-"); expect(await readFile(join(directory, name), "utf8")).toBe(registration);
  } finally { stop.mockRestore(); kill.mockRestore(); }
});
