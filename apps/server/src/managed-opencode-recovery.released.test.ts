import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { z } from "zod";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const ready = z.object({ pid: z.number().int().positive(), url: z.string().url(), password: z.string(), args: z.array(z.string()) });
const pidInfo = ready.pick({ pid: true });
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; }
};
const until = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error("Native stdin lease fixture did not settle."); await Bun.sleep(2); }
};
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
    const address = server.address(); server.close(() => { if (typeof address === "object" && address) resolve(address.port); else reject(new Error("No fixture port.")); });
  });
});
const accepts = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
});

test.skipIf(!binary)("native recovery stdin lease closes after host SIGKILL before readiness and preserves same-DB history across ready-state restart", async () => {
  if (!binary) throw new Error("A released engine binary is required.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-stdio-crash-")));
  const children: Array<ReturnType<typeof spawn>> = [], ownedPIDs: number[] = [], evidence: unknown[] = [];
  const startHost = async (directory: string, mode = "managed", port = 0) => {
    await mkdir(directory, { recursive: true });
    await rm(join(directory, "ready.json"), { force: true });
    const args = [
      ...(process.env.LEGALWORK_TEST_CANDIDATE_DIRECTORY ? ["--preload", join(import.meta.dir, "../../../packages/opencode-release/build/validation-preload.mjs")] : []),
      join(import.meta.dir, "managed-recovery.test-support.ts"), directory, binary, mode, String(port),
    ];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] }); children.push(child);
    let diagnostics = ""; child.stderr?.on("data", chunk => { diagnostics += chunk.toString(); });
    const file = join(directory, mode === "before-ready" ? "spawned.json" : "ready.json");
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private fixture host exited: ${diagnostics}`);
      try { return pidInfo.safeParse(JSON.parse(await readFile(file, "utf8"))).success; }
      catch (error) { if (error instanceof SyntaxError || error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
    });
    const endpoint = pidInfo.parse(JSON.parse(await readFile(file, "utf8"))); ownedPIDs.push(endpoint.pid);
    return { child, endpoint, file };
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort(), host = await startHost(join(root, `before-${attempt}`), "before-ready", port);
      const listenerWasUp = await accepts(port); expect(listenerWasUp).toBe(false);
      host.child.kill("SIGKILL"); await until(async () => host.child.signalCode === "SIGKILL" && !alive(host.endpoint.pid));
      evidence.push({ phase: "before-listener", at: new Date().toISOString(), hostPID: host.child.pid, enginePID: host.endpoint.pid, listenerWasUp, nativeExited: !alive(host.endpoint.pid) });
    }
    const directory = join(root, "same-database"), first = await startHost(directory);
    const firstEndpoint = ready.parse(JSON.parse(await readFile(first.file, "utf8")));
    const clientFor = (endpoint: z.infer<typeof ready>) => OpenCode.make({ baseUrl: endpoint.url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}` } });
    const firstClient = clientFor(firstEndpoint), info = await firstClient.server.info();
    expect(info.pid).toBe(firstEndpoint.pid); expect(firstEndpoint.args).toContain("--stdio"); expect(firstEndpoint.args).not.toContain("--service");
    const unauthorized = await fetch(new URL("/api/info", firstEndpoint.url)); expect(unauthorized.status).toBe(401); await unauthorized.body?.cancel();
    const session = await firstClient.session.create({ location: { directory }, title: "Preserved stdin lease history" });
    await firstClient.session.synthetic({ sessionID: session.id, text: "Preserved queued recovery content", resume: false });
    const before = { session: await firstClient.session.get({ sessionID: session.id }), context: await firstClient.session.context({ sessionID: session.id }), inbox: await firstClient.session.inbox.list({ sessionID: session.id }) };
    first.child.kill("SIGKILL"); await until(async () => first.child.signalCode === "SIGKILL" && !alive(firstEndpoint.pid));
    const second = await startHost(directory), secondEndpoint = ready.parse(JSON.parse(await readFile(second.file, "utf8"))), secondClient = clientFor(secondEndpoint);
    expect(secondEndpoint.pid).not.toBe(firstEndpoint.pid); expect(secondEndpoint.password).not.toBe(firstEndpoint.password);
    const secondInfo = await secondClient.server.info(); expect(secondInfo.pid).toBe(secondEndpoint.pid); expect(secondInfo.version).toBe(info.version);
    const after = { session: await secondClient.session.get({ sessionID: session.id }), context: await secondClient.session.context({ sessionID: session.id }), inbox: await secondClient.session.inbox.list({ sessionID: session.id }) };
    expect(after.session.id).toBe(session.id); expect(after.context).toEqual(before.context); expect(after.inbox).toEqual(before.inbox); expect(JSON.stringify(after)).toContain("Preserved queued recovery content");
    second.child.kill("SIGTERM"); await until(async () => second.child.exitCode === 0 && !alive(secondEndpoint.pid));
    expect(alive(secondEndpoint.pid)).toBe(false);
    evidence.push({ phase: "managed-ready-restart", at: new Date().toISOString(), firstHostPID: first.child.pid, secondHostPID: second.child.pid, firstInfo: info, secondInfo, args: firstEndpoint.args, before, after, firstExitedBeforeReplacement: true, normalEofStop: second.child.exitCode === 0 });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const cleanupRequiredPIDs = ownedPIDs.filter(alive);
    for (const pid of cleanupRequiredPIDs) process.kill(pid, "SIGKILL");
    const evidenceDirectory = process.env.LEGALWORK_RECOVERY_ACCEPTANCE_DIR;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(evidenceDirectory, "stdio-crash-restart.json"), JSON.stringify({ evidence, cleanupRequiredPIDs }, null, 2), { mode: 0o600 });
    }
    await rm(root, { recursive: true, force: true });
  }
}, 75_000);
