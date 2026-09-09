import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LocalMailService } from "./service.js";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const nodePath = Bun.which("node");
if (!nodePath) throw new Error("Compatible Node is required");
let directory = "";
let entryPoint = "";
const services: LocalMailService[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "legalwork-mail-service-"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await symlink(join(serverRoot, "node_modules"), join(directory, "node_modules"));
  execFileSync("pnpm", ["exec", "tsc", "--outDir", join(directory, "build"), "--rootDir", "src", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--types", "node,bun-types", "src/mail/runtime/worker.ts"], { cwd: serverRoot, stdio: "pipe", timeout: 30_000 });
  entryPoint = join(directory, "build/mail/runtime/worker.js");
}, 30_000);
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup(loadKey?: () => Promise<Uint8Array>) {
  const privateDir = await mkdtemp(join(directory, "store-"));
  const databasePath = join(privateDir, "mail.sqlite");
  const key = randomBytes(32);
  const supplied: Uint8Array[] = [];
  const service = new LocalMailService({
    entryPoint, databasePath, ownerId: "desktop-local", executable: { kind: "node", path: nodePath! },
    loadKey: loadKey ?? (async () => { const bytes = new Uint8Array(key); supplied.push(bytes); return bytes; }),
  });
  services.push(service);
  return { service, databasePath, supplied };
}
test("service stays locked without vault access until unlock, clears supplied keys, and reopens", async () => {
  const { service, databasePath, supplied } = await setup();
  expect(service.status().state).toBe("locked");
  expect(supplied).toHaveLength(0);
  await expect(stat(databasePath)).rejects.toThrow();
  await expect(service.listAccounts({})).rejects.toThrow("mail_locked");
  const first = service.unlock();
  expect(service.unlock()).toBe(first);
  await first;
  expect(service.status()).toEqual({ protocolVersion: 1, state: "ready", syncSupported: false });
  expect(supplied).toHaveLength(1);
  expect(supplied[0]?.every(byte => byte === 0)).toBe(true);
  expect(await service.listAccounts({ limit: 1 })).toEqual({ items: [], nextCursor: null });
  await expect(service.listFolders("missing", {})).rejects.toThrow("mail_not_found");
  const locking = service.lock();
  await expect(service.listAccounts({})).rejects.toThrow("mail_locked");
  await locking;
  expect(service.status().state).toBe("locked");
  await service.unlock();
  expect(await service.listAccounts({})).toEqual({ items: [], nextCursor: null });
  expect(supplied).toHaveLength(2);
});
test("stop forbids reactivation and new requests before asynchronous cleanup finishes", async () => {
  const { service } = await setup();
  await service.unlock();
  const stopping = service.stop();
  expect(service.status().state).toBe("stopped");
  await expect(service.unlock()).rejects.toThrow("mail_unavailable");
  await expect(service.listAccounts({})).rejects.toThrow("mail_unavailable");
  await stopping;
});
test("locking while key retrieval is pending prevents a late worker start", async () => {
  let requested = () => {};
  const started = new Promise<void>(resolve => { requested = resolve; });
  let supply: (key: Uint8Array) => void = () => {};
  const pendingKey = new Promise<Uint8Array>(resolve => { supply = resolve; });
  const { service, databasePath } = await setup(async () => { requested(); return pendingKey; });
  const unlocking = service.unlock();
  const rejected = unlocking.then(() => false, () => true);
  await started;
  await service.lock();
  expect(await rejected).toBe(true);
  const key = randomBytes(32);
  supply(key);
  // Observe completion of the supplier's continuation without waiting on a timer.
  await pendingKey; await Promise.resolve(); await Promise.resolve();
  expect(key.every(byte => byte === 0)).toBe(true);
  await expect(stat(databasePath)).rejects.toThrow();
  expect(service.status().state).toBe("locked");
});
test("vault failures and invalid keys are redacted and cannot claim ready", async () => {
  for (const supplier of [async () => { throw new Error("private-path secret-token"); }, async () => new Uint8Array(31)]) {
    const { service, databasePath } = await setup(supplier);
    await expect(service.unlock()).rejects.toThrow("mail_unavailable");
    expect(service.status().state).toBe("locked");
    await expect(stat(databasePath)).rejects.toThrow();
  }
});
