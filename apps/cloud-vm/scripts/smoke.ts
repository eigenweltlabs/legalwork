import { readFileSync, writeFileSync } from "node:fs";
import { Sandbox } from "e2b";
import { z } from "zod";

const ControllerWorker = z.object({ userId: z.string(), sandboxId: z.string(), clientToken: z.string(), synced: z.literal(false) });
const tokenFile = process.env.CONTROLLER_TOKEN_FILE;
const apiKeyFile = process.env.E2B_API_KEY_FILE;
if (!tokenFile || !apiKeyFile || !process.env.E2B_API_URL || !process.env.E2B_SANDBOX_URL) throw new Error("Controller/E2B endpoint and token files are required");
const controller = process.env.CONTROLLER_URL ?? "http://127.0.0.1:8788";
const adminHeaders = { Authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
const options = { apiKey: readFileSync(apiKeyFile, "utf8").trim(), apiUrl: process.env.E2B_API_URL, sandboxUrl: process.env.E2B_SANDBOX_URL };
const prefix = process.env.SMOKE_USER_PREFIX ?? `smoke-${Date.now()}`;
async function command(userId: string, action: string) {
  const response = await fetch(`${controller}/users/${userId}/${action}`, { method: "POST", headers: adminHeaders, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${action} failed: ${response.status} ${await response.text()}`);
  return response;
}
const times: Record<string, number> = {};
const workers: z.infer<typeof ControllerWorker>[] = [];
try {
  for (const suffix of ["alice", "bob"]) {
    const started = performance.now();
    const worker = ControllerWorker.parse(await (await command(`${prefix}-${suffix}`, "provision")).json());
    workers.push(worker);
    times[`create_${suffix}_ms`] = Math.round(performance.now() - started);
    const health = await fetch(`${controller}/users/${worker.userId}/worker/health`, { headers: { Authorization: `Bearer ${worker.clientToken}` } });
    if (!health.ok) throw new Error("Authenticated worker health failed");
    const workspaces = await fetch(`${controller}/users/${worker.userId}/worker/workspaces`, { headers: { Authorization: `Bearer ${worker.clientToken}` } });
    if (!workspaces.ok) throw new Error("Workspace API failed");
  }
  const alice = workers[0]!, bob = workers[1]!;
  if (alice.sandboxId === bob.sandboxId) throw new Error("Users share a sandbox");
  const rejected = await fetch(`${controller}/users/${bob.userId}/worker/workspaces`, { headers: { Authorization: `Bearer ${alice.clientToken}` } });
  if (rejected.status !== 401) throw new Error("Cross-user routing was not rejected");
  const a = await Sandbox.connect(alice.sandboxId, options);
  const b = await Sandbox.connect(bob.sandboxId, options);
  await a.commands.run("cd /opt/legalwork && ./bun -e 'const {createCanvas}=require(\"@napi-rs/canvas\"); if(createCanvas(10,10).toBuffer(\"image/png\").length < 20) process.exit(1)'", { user: "root" });
  await a.commands.run("if curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/ >/dev/null 2>&1; then exit 1; fi", { user: "root" });
  await a.files.write("/data/projects/Assistant/persistence.txt", "alice-private-file\n", { user: "root" });
  const isolated = await b.commands.run("test ! -e /data/projects/Assistant/persistence.txt", { user: "root" });
  if (isolated.exitCode !== 0) throw new Error("Files crossed user boundaries");
  const pauseStarted = performance.now();
  await command(alice.userId, "pause");
  times.pause_ms = Math.round(performance.now() - pauseStarted);
  const wakeStarted = performance.now();
  await command(alice.userId, "wake");
  times.wake_ms = Math.round(performance.now() - wakeStarted);
  const resumed = await Sandbox.connect(alice.sandboxId, options);
  if ((await resumed.files.read("/data/projects/Assistant/persistence.txt", { user: "root" })).trim() !== "alice-private-file") throw new Error("Pause/resume lost user data");
  const recordFile = process.env.SMOKE_RECORD_FILE ?? "/tmp/legalwork-e2b-smoke-workers.json";
  writeFileSync(recordFile, JSON.stringify(workers), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, workers: workers.map(({ userId, sandboxId }) => ({ userId, sandboxId })), timings: times, recordFile }));
} finally {
  for (const worker of workers) await command(worker.userId, "pause");
}
