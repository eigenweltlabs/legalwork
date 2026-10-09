import { readFileSync } from "node:fs";
import { Sandbox } from "e2b";
import { z } from "zod";
import { UserId } from "../src/store.js";

const Worker = z.object({ userId: UserId, sandboxId: z.string(), clientToken: z.string(), synced: z.literal(false) });
const Status = z.object({ sandboxId: z.string(), state: z.string() });
const tokenFile = process.env.CONTROLLER_TOKEN_FILE;
const apiKeyFile = process.env.E2B_API_KEY_FILE;
if (!tokenFile || !apiKeyFile || !process.env.E2B_API_URL || !process.env.E2B_SANDBOX_URL) throw new Error("Controller/E2B endpoint and token files are required");
const controller = process.env.CONTROLLER_URL ?? "http://127.0.0.1:8788";
const adminHeaders = { Authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
const options = { apiKey: readFileSync(apiKeyFile, "utf8").trim(), apiUrl: process.env.E2B_API_URL, sandboxUrl: process.env.E2B_SANDBOX_URL };
const workers = z.array(Worker).length(2).parse(JSON.parse(readFileSync(process.env.SMOKE_RECORD_FILE ?? "/tmp/legalwork-e2b-smoke-workers.json", "utf8")));
async function admin(userId: string, action: string, method = "POST") {
  const response = await fetch(`${controller}/users/${userId}/${action}`, { method, headers: adminHeaders, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${action} failed: ${response.status}`);
  return response;
}
const timings: Record<string, number> = {};
const awakened: string[] = [];
try {
  for (const worker of workers) {
    const status = Status.parse(await (await admin(worker.userId, "status", "GET")).json());
    if (status.sandboxId !== worker.sandboxId || status.state !== "paused") throw new Error("Paused mapping did not survive host replacement");
    const started = performance.now();
    await admin(worker.userId, "wake");
    awakened.push(worker.userId);
    timings[`${worker.userId.endsWith("alice") ? "alice" : "bob"}_wake_ms`] = Math.round(performance.now() - started);
    for (const endpoint of ["health", "workspaces"]) {
      const response = await fetch(`${controller}/users/${worker.userId}/worker/${endpoint}`, { headers: { Authorization: `Bearer ${worker.clientToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("Persisted worker token/API failed after replacement");
      await response.arrayBuffer();
    }
  }
  const alice = workers[0]!, bob = workers[1]!;
  if (alice.sandboxId === bob.sandboxId) throw new Error("Users share a sandbox");
  const a = await Sandbox.connect(alice.sandboxId, options);
  const b = await Sandbox.connect(bob.sandboxId, options);
  if ((await a.files.read("/data/projects/Assistant/persistence.txt", { user: "root" })).trim() !== "alice-private-file") throw new Error("Replacement lost the paused user filesystem");
  await b.commands.run("test ! -e /data/projects/Assistant/persistence.txt", { user: "root" });
  const rejected = await fetch(`${controller}/users/${bob.userId}/worker/workspaces`, { headers: { Authorization: `Bearer ${alice.clientToken}` } });
  if (rejected.status !== 401) throw new Error("Cross-user routing was not rejected after replacement");
  console.log(JSON.stringify({ ok: true, recovered: workers.map(({ userId, sandboxId }) => ({ userId, sandboxId })), timings }));
} finally {
  for (const userId of awakened) await admin(userId, "pause");
}
