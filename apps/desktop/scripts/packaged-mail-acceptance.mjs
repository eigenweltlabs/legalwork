import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

/** Hosted Linux fixture only: private keyring, private D-Bus session, no plaintext backend. */
export async function startMailTestSecretService(root, env) {
  assert.ok(env.DBUS_SESSION_BUS_ADDRESS, "Run Linux mail acceptance inside dbus-run-session");
  const control = join(root, "keyring"), runtime = join(root, "xdg-runtime");
  await mkdir(control, { mode: 0o700 }); await mkdir(runtime, { mode: 0o700 });
  Object.assign(env, { GNOME_KEYRING_CONTROL: control, XDG_RUNTIME_DIR: runtime });
  const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", `--control-directory=${control}`],
    { env, stdio: ["pipe", "ignore", "ignore"] });
  let launchError, closed = false;
  daemon.on("error", error => { launchError = error; }); daemon.on("close", () => { closed = true; });
  daemon.stdin.on("error", () => {}); daemon.stdin.end(randomBytes(32).toString("hex"));
  const stop = async () => {
    daemon.kill();
    for (let attempt = 0; attempt < 50 && !closed; attempt++) await setTimeout(100);
    if (!closed) daemon.kill("SIGKILL");
    for (let attempt = 0; attempt < 50 && !closed; attempt++) await setTimeout(100);
    assert.ok(closed, "Private test keyring must stop before deleting its files");
  };
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (launchError) throw launchError;
      assert.equal(closed, false, "Private test keyring exited before readiness");
      const result = await promisify(execFile)("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"], { env, timeout: 1000, maxBuffer: 4096 });
      if (result.stdout.trim() === "(true,)") return stop;
      await setTimeout(100);
    }
    throw Error("Private test keyring did not register Secret Service");
  } catch (error) { await stop(); throw error; }
}

/** Actual packaged main process, actual OS-wrapped key and production worker factory. */
export async function verifyPackagedMailHttp(base, tokens) {
  assert.ok(typeof tokens.hostToken === "string" && tokens.hostToken.length > 16);
  const headers = { "x-legalwork-host-token": tokens.hostToken };
  const request = (path, method = "GET", auth = headers) => fetch(`${base}/mail/v1${path}`, { method, headers: auth, signal: AbortSignal.timeout(20_000) });
  assert.equal((await request("/accounts")).status, 423);
  for (const token of [tokens.clientToken, tokens.hostToken, "synthetic-remote-token"]) {
    assert.equal((await request("/unlock", "POST", { authorization: `Bearer ${token}` })).status, 401);
  }
  assert.equal((await request("/unlock", "POST", { "x-legalwork-host-token": tokens.clientToken })).status, 401);
  assert.equal((await request("/unlock", "POST", {})).status, 401);
  for (let reopen = 0; reopen < 2; reopen++) {
    const unlocked = await request("/unlock", "POST");
    assert.equal(unlocked.status, 200, "Packaged mail must unlock through the real OS vault and bundled Node worker");
    assert.equal(unlocked.headers.get("cache-control"), "no-store");
    const status = await unlocked.json(); assert.equal(status.protocolVersion, 1); assert.equal(status.state, "ready"); assert.equal(status.syncSupported, true);
    const read = await request("/status"); assert.equal(read.status, 200); assert.equal((await read.json()).state, "ready");
    const accounts = await request("/accounts"); assert.equal(accounts.status, 200);
    assert.deepEqual(await accounts.json(), { items: [], nextCursor: null });
    assert.equal((await request("/lock", "POST")).status, 200);
    assert.equal((await request("/accounts")).status, 423);
  }
}
