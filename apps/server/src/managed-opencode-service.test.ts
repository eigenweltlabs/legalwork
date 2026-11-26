import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { stopManagedOpencodeService } from "./managed-opencode-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const password = "synthetic-private-registration";

async function registered(pid: number, url: string) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-service-registration-")); roots.push(root);
  const directory = join(root, "state", "opencode"); await mkdir(directory, { recursive: true });
  const file = join(directory, "service-legalwork.json"), text = JSON.stringify({ pid, url, password });
  await writeFile(file, text, { mode: 0o600 });
  return { directory, file, text, options: { stateDirectory: join(root, "state"), configDirectory: join(root, "config") } };
}

async function listening(server: net.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
  return `http://127.0.0.1:${address.port}`;
}

async function expectSetAside(f: Awaited<ReturnType<typeof registered>>) {
  const files = await readdir(f.directory); expect(files).toHaveLength(1);
  const name = files[0]; if (!name) throw new Error("Preserved registration missing");
  expect(name).toStartWith("service-legalwork.json.stale-");
  expect(await readFile(join(f.directory, name), "utf8")).toBe(f.text);
}

test("a registration whose PID now belongs to a process started after it is set aside without signalling that process", async () => {
  // Windows reuses PIDs quickly, often for LegalWork's own next processes.
  const reused = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const server = net.createServer(), url = await listening(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  try {
    if (!reused.pid) throw new Error("Expected a live fixture process");
    const f = await registered(reused.pid, url);
    const written = new Date(Date.now() - 90 * 60_000); await utimes(f.file, written, written);
    const kill = spyOn(process, "kill"), stop = spyOn(Service, "stop");
    try { await stopManagedOpencodeService(f.options); expect(kill).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); }
    finally { kill.mockRestore(); stop.mockRestore(); }
    expect(reused.exitCode).toBe(null); expect(reused.signalCode).toBe(null);
    await expectSetAside(f);
  } finally { reused.kill(); }
});

for (const status of [200, 503]) test(`an engine answering ${status} with the registered password and PID is stopped through its registration`, async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++; expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
    return Response.json({ version: "2.1.4-legalwork.http-policy.8", pid: 4242 }, { status });
  } });
  const stop = spyOn(Service, "stop").mockImplementation(async () => {});
  try {
    const f = await registered(4242, server.url.origin);
    await stopManagedOpencodeService(f.options);
    expect(stop).toHaveBeenCalledWith({ file: f.file, pty: "clear" }); expect(requests).toBe(1);
  } finally { stop.mockRestore(); server.stop(true); }
});

test("another program answering on the registered port proves the registration stale", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ version: "unrelated", pid: 9999 }) });
  const stop = spyOn(Service, "stop");
  try {
    const f = await registered(4242, server.url.origin);
    await stopManagedOpencodeService(f.options);
    expect(stop).not.toHaveBeenCalled(); await expectSetAside(f);
  } finally { stop.mockRestore(); server.stop(true); }
});

test("a listener that accepts but never answers blocks startup and keeps the registration", async () => {
  const sockets: net.Socket[] = [], server = net.createServer(socket => { sockets.push(socket); });
  const stop = spyOn(Service, "stop");
  try {
    const f = await registered(4242, await listening(server));
    await expect(stopManagedOpencodeService(f.options)).rejects.toThrow("does not answer");
    expect(stop).not.toHaveBeenCalled(); expect(await readdir(f.directory)).toEqual(["service-legalwork.json"]);
  } finally {
    stop.mockRestore(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);
