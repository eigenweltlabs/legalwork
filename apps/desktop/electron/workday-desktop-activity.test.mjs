import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createWorkdayDesktopCollector, desktopActivityOwner } from "./workday-desktop-activity.mjs";
import { createWindowsForegroundReader } from "./workday-windows-foreground.mjs";

const active = { application: "Example Editor", pid: 42, accessibility: true, documentName: "Brief.docx" };
const context = { platform: "darwin", available: () => true, trusted: () => true, helperTrusted: () => true, requestPermission: () => {},
  owner: async () => "local-profile", power: { getSystemIdleState: () => "active", getSystemIdleTime: () => 2 },
  readForeground: async () => active, processId: 42, now: () => 1_000 };

test("macOS reports a semantic document basename only with both forms of trust", async () => {
  assert.deepEqual(await createWorkdayDesktopCollector(context).sample(), {
    platform: "darwin", permission: "granted", state: "active", observedAt: 1_000, idleSeconds: 2,
    application: "Example Editor", documentName: "Brief.docx", isLegalWork: true,
  });
  const options = { ...context, trusted: () => false, readForeground: async withDocument => {
    assert.equal(withDocument, false);
    return { ...active, pid: 31, title: "private", text: "private" };
  } };
  assert.deepEqual(await createWorkdayDesktopCollector(options).sample(), { platform: "darwin", permission: "needed",
    state: "active", observedAt: 1_000, idleSeconds: 2, application: "Example Editor" });
  const helperUntrusted = await createWorkdayDesktopCollector({ ...context, readForeground: () => ({ ...active, accessibility: false }) }).sample();
  assert.equal(helperUntrusted.permission, "needed");
  assert.ok(!("documentName" in helperUntrusted));
});

test("status checks, missing consent, and unsupported systems do not capture or prompt", async () => {
  let observations = 0, prompts = 0;
  const options = { ...context, trusted: () => prompts > 0, requestPermission: () => { prompts++; },
    readForeground: () => { observations++; return active; }, owner: async () => undefined };
  const mac = createWorkdayDesktopCollector(options);
  assert.equal((await mac.status()).permission, "needed");
  assert.equal((await mac.sample()).state, "unavailable");
  assert.equal(prompts, 0);
  assert.equal((await mac.requestPermission()).permission, "needed");
  assert.equal(prompts, 0);
  for (const alternative of [{ platform: "linux" }, { available: () => false }]) {
    const collector = createWorkdayDesktopCollector({ ...options, ...alternative });
    assert.equal((await collector.requestPermission()).permission, "unavailable");
    assert.equal((await collector.sample()).state, "unavailable");
  }
  assert.equal(observations, 0);
  assert.equal(prompts, 0);
});

test("Settings checks and requests the actual macOS helper grant when only Electron is trusted", async () => {
  let helperGrant = false, enabled = false, checked = 0, prompts = 0;
  const collector = createWorkdayDesktopCollector({ ...context, owner: () => enabled ? "profile" : undefined,
    helperTrusted: () => { checked++; return helperGrant; },
    readForeground: () => { throw Error("Settings must not observe any window"); },
    requestPermission: () => { prompts++; helperGrant = true; },
  });
  await collector.status();
  await collector.requestPermission();
  assert.equal(checked, 0);
  assert.equal(prompts, 0);
  enabled = true;
  assert.equal((await collector.status()).permission, "needed");
  assert.equal((await collector.requestPermission()).permission, "granted");
  await collector.requestPermission();
  assert.equal(prompts, 1);
});

test("idle, locked and unknown sessions do not query other applications", async () => {
  let observations = 0;
  for (const [session, seconds, expected] of [["locked", 0, "locked"], ["idle", 60, "idle"], ["active", 65, "idle"],
    ["unknown", 0, "unavailable"], ["active", NaN, "unavailable"]]) {
    const power = { getSystemIdleState: limit => { assert.equal(limit, 60); return session; }, getSystemIdleTime: () => seconds };
    const sample = await createWorkdayDesktopCollector({ ...context, power, readForeground: () => { observations++; } }).sample();
    assert.equal(sample.state, expected);
    assert.ok(!("application" in sample));
  }
  assert.equal(observations, 0);
});

test("discard a foreground response on profile change, lock or consent revocation", async () => {
  let reads = 0;
  const switched = await createWorkdayDesktopCollector({ ...context, owner: () => ++reads === 1 ? "A" : "B" }).sample();
  assert.equal(switched.state, "unavailable");
  let unlocked = true;
  const power = { ...context.power, getSystemIdleState: () => unlocked ? "active" : "locked" };
  const locked = await createWorkdayDesktopCollector({ ...context, power, readForeground: () => { unlocked = false; return active; } }).sample();
  assert.equal(locked.state, "locked");
  let trusted = true;
  const revoked = await createWorkdayDesktopCollector({ ...context, trusted: () => trusted,
    readForeground: () => { trusted = false; return active; } }).sample();
  assert.equal(revoked.permission, "needed");
  assert.ok(!("documentName" in revoked));
  for (const sample of [switched, locked]) assert.ok(!("application" in sample));
});

test("Windows yields the foreground process only and does not request Accessibility", async () => {
  const collector = createWorkdayDesktopCollector({ ...context, platform: "win32", trusted: () => { throw Error("macOS only"); },
    requestPermission: () => { throw Error("macOS only"); }, readForeground: includeDocument => {
      assert.equal(includeDocument, false);
      return { ...active, pid: 21 };
    } });
  assert.equal((await collector.requestPermission()).permission, "granted");
  assert.deepEqual(await collector.sample(), { platform: "win32", permission: "granted", idleSeconds: 2,
    observedAt: 1_000, state: "active", application: active.application });
  const locked = await createWorkdayDesktopCollector({ ...context, platform: "win32", readForeground: () => ({ locked: true }) }).sample();
  assert.equal(locked.state, "locked");
  assert.ok(!("application" in locked));
});

test("malformed and unsafe native data never exposes paths or control content", async () => {
  for (const native of [null, {}, { ...active, application: "C:\\Private\\Editor" }, { ...active, pid: 0 }]) {
    assert.equal((await createWorkdayDesktopCollector({ ...context, readForeground: () => native }).sample()).state, "unavailable");
  }
  for (const documentName of ["https://example.test/1", "/private/folder/brief", "line\nbreak", "C:\\Private\\Draft.doc", ".hidden"]) {
    const sample = await createWorkdayDesktopCollector({ ...context, readForeground: () => ({ ...active, documentName }) }).sample();
    assert.equal(sample.application, active.application);
    assert.ok(!("documentName" in sample));
  }
});

test("native capture checks the host-protected opt-in on the loopback server", async () => {
  const info = { running: true, hostToken: "test", baseUrl: "http://127.0.0.1" };
  let reads = 0;
  const request = async (_info, route) => {
    reads++;
    assert.equal(route, "/private-timesheet/activity");
    return { profileId: "owner", enabled: true, desktopActivity: true };
  };
  for (const invalid of [{ ...info, running: false }, { ...info, hostToken: "" }, { ...info, baseUrl: "https://example.test" }]) {
    assert.equal(await desktopActivityOwner(invalid, request), undefined);
  }
  assert.equal(reads, 0);
  assert.ok(await desktopActivityOwner(info, request));
  for (const overrides of [{ enabled: false }, { desktopActivity: false }, { profileId: "" }]) {
    assert.equal(await desktopActivityOwner(info, async () => ({ ...(await request(info, "/private-timesheet/activity")), ...overrides })), undefined);
  }
});

test("Windows helper is lazy, requests only focus, reuses its worker and handles failure", async () => {
  const processes = [];
  function spawnFake(exe, args, options) {
    assert.equal(exe, "fixture-powershell");
    assert.equal(options.windowsHide, true);
    const script = args.at(-1);
    assert.match(script, /GetForegroundWindow/);
    assert.match(script, /GetGUIThreadInfo/);
    assert.doesNotMatch(script, /GetWindowText|MainWindowTitle|GetAsyncKeyState|TextPattern|ValuePattern/);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
    processes.push(child);
    return child;
  }
  const reader = createWindowsForegroundReader("fixture-powershell", /** @type {any} */ (spawnFake));
  assert.equal(processes.length, 0);
  const first = reader.read();
  assert.equal(processes[0].stdin.read().toString(), "sample\n");
  processes[0].stdout.write('{"application":"Editor","pid":12}\n');
  assert.deepEqual(await first, { application: "Editor", pid: 12 });
  const second = reader.read();
  processes[0].emit("exit");
  assert.equal(await second, undefined);
  assert.equal(processes.length, 1);
  const third = reader.read();
  processes[1].stdout.write("invalid\n");
  assert.equal(await third, undefined);
  reader.close();
});

test("Windows terminates a stalled worker, ignores its late replies and retires an unused worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workers = [];
  const spawnFake = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kills: 0,
      kill() { this.kills++; } });
    workers.push(child);
    return child;
  };
  const reader = createWindowsForegroundReader("fixture-powershell", /** @type {any} */ (spawnFake));
  const stalled = reader.read();
  t.mock.timers.tick(4_000);
  assert.equal(await stalled, undefined);
  assert.equal(workers[0].kills, 1);
  const recovered = reader.read();
  workers[0].stdout.write('{"application":"Stale","pid":1}\n');
  workers[1].stdout.write('{"application":"New","pid":2}\n');
  assert.deepEqual(await recovered, { application: "New", pid: 2 });
  t.mock.timers.tick(35_000);
  assert.equal(workers[1].kills, 1);
  assert.equal(workers[1].stdin.read().toString(), "sample\n");
  const shuttingDown = reader.read();
  reader.close();
  assert.equal(await shuttingDown, undefined);
  assert.equal(workers[2].kills, 1);
});
