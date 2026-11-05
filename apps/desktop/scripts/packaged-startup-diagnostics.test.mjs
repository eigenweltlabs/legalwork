import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectStartupFailure, scrubStartupText, snapshotStartupLogs } from "./packaged-startup-diagnostics.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-startup-diagnostics-"));
  const userData = path.join(root, "userdata"), runtime = path.join(root, "runtime"), logs = path.join(userData, "logs");
  await mkdir(logs, { recursive: true }); await mkdir(runtime);
  const base = { artifactDirectory: path.join(root, "artifacts"), root, userData, runtime, logDirectories: [logs],
    child: { pid: process.pid, exitCode: null, signalCode: null, killed: false }, output: "", milestones: [],
    failure: new Error("synthetic engine startup failed"), selection: { version: "fixture-only" },
    processSnapshot: () => [{ pid: process.pid, parentPid: 0, name: "fixture-only" }] };
  try { await run(base, logs); } finally { await rm(root, { recursive: true, force: true }); }
}

test("failure evidence redacts known and unknown credentials/cookies, retaining errors and metadata without copying state", () => fixture(async (base, logs) => {
  const logBaseline = await snapshotStartupLogs([logs]);
  const startedAt = Date.now() - 1000;
  const password = 'native-long-password-"line\\value';
  const token = "client-private-token", apiKey = "provider-private-api-key";
  const credentialUrl = new URL("https://invalid.test/path");
  credentialUrl.username = "unknown-user";
  credentialUrl.password = "unknown-password";
  await writeFile(path.join(base.userData, "legalwork-server-tokens.json"), JSON.stringify({ token, username: "native-user", password }));
  await writeFile(path.join(base.runtime, "server.json"), JSON.stringify({ providers: { fixture: { apiKey } } }));
  await writeFile(path.join(base.runtime, "runtime.db"), "PRIVATE_DATABASE_CONTENT_MUST_NOT_BE_COPIED");
  await writeFile(path.join(base.userData, "Cookies"), "PRIVATE_COOKIE_DATABASE_MUST_NOT_BE_COPIED");
  const text = ["TypeError: synthetic useful failure", "    at actual-module.mjs:42:9", `bare known token ${token}`,
    `bare password ${password}`, `encoded password ${encodeURIComponent(password)}`, `API key ${apiKey}`,
    `Authorization: Basic ${Buffer.from(`native-user:${password}`).toString("base64")}`,
    "Cookie: session=unknown-cookie-value; other=unknown-second-cookie", "Set-Cookie: sid=unknown-set-cookie; HttpOnly",
    'api_key="unknown-api-key-value"', credentialUrl.href, "Uncaught renderer exception"].join("\n");
  await writeFile(path.join(logs, "main.log"), text);
  await writeFile(path.join(logs, "chromium-startup.log"), `Chromium startup: ${text}`);
  const result = await collectStartupFailure({ ...base, startedAt, logBaseline, output: text,
    windowSnapshot: (pid) => {
      assert.equal(pid, base.child.pid);
      return [{ pid: process.pid, title: `Main process error ${token}`, controls: [{ name: text, controlType: "ControlType.Text" }] }];
    },
    milestones: [{ event: "renderer-controls-ready", elapsedMs: 250 }] });
  const files = await readdir(result.directory);
  assert.deepEqual(files.sort(), ["application-0-main.log", "application-3-chromium-startup.log", "diagnostics.json", "stdio.log"]);
  const artifacts = (await Promise.all(files.map(name => readFile(path.join(result.directory, name), "utf8")))).join("\n");
  for (const secret of [password, encodeURIComponent(password), token, apiKey, "unknown-cookie-value", "unknown-second-cookie",
    "unknown-set-cookie", "unknown-api-key-value", "unknown-password", "PRIVATE_DATABASE_CONTENT_MUST_NOT_BE_COPIED", "PRIVATE_COOKIE_DATABASE_MUST_NOT_BE_COPIED"])
    assert.equal(artifacts.includes(secret), false, `must not disclose ${secret}`);
  assert.match(artifacts, /TypeError: synthetic useful failure/); assert.match(artifacts, /actual-module\.mjs:42:9/);
  assert.match(artifacts, /Uncaught renderer exception/);
  const summary = JSON.parse(await readFile(path.join(result.directory, "diagnostics.json"), "utf8"));
  assert.equal(summary.states.find(item => item.path.endsWith("runtime.db")).size, 43);
  assert.equal(summary.states.find(item => item.path.endsWith("legalwork-server-tokens.json")).regularFile, true);
  assert.equal(summary.milestones[0].elapsedMs, 250); assert.equal(summary.child.exitCode, null);
  assert.equal(summary.windows[0].title, "Main process error <redacted>");
  assert.match(summary.windows[0].controls[0].name, /TypeError: synthetic useful failure/);
}));

test("prelaunch host-log bytes and log symlinks are excluded even after append and rotation", () => fixture(async (base, logs) => {
  const main = path.join(logs, "main.log");
  await writeFile(main, "PRIOR_LAUNCH_PRIVATE_CONTENT\n");
  const logBaseline = await snapshotStartupLogs([logs]);
  const startedAt = Date.now() - 1000;
  await appendFile(main, "TypeError: current launch failure\n");
  await rename(main, path.join(logs, "main.old.log"));
  await writeFile(path.join(base.runtime, "server.json"), '{"privateMarker":"CONFIG_MUST_NOT_BE_COPIED"}');
  await symlink(path.join(base.runtime, "server.json"), main, process.platform === "win32" ? "file" : undefined);
  await writeFile(path.join(logs, "runtime-boot-failure.log"), "STALE_LOG_MUST_NOT_BE_COPIED");
  await utimes(path.join(logs, "runtime-boot-failure.log"), new Date(0), new Date(0));
  await symlink(path.join(base.runtime, "server.json"), path.join(logs, "chromium-startup.log"), process.platform === "win32" ? "file" : undefined);
  const result = await collectStartupFailure({ ...base, startedAt, logBaseline,
    processSnapshot: () => { throw new Error("synthetic OS process inspection unavailable"); },
    windowSnapshot: (pid) => {
      assert.equal(pid, base.child.pid);
      throw new Error("synthetic native window inspection unavailable");
    } });
  const artifacts = (await Promise.all((await readdir(result.directory)).map(name => readFile(path.join(result.directory, name), "utf8")))).join("\n");
  for (const text of ["PRIOR_LAUNCH_PRIVATE_CONTENT", "CONFIG_MUST_NOT_BE_COPIED", "STALE_LOG_MUST_NOT_BE_COPIED"])
    assert.equal(artifacts.includes(text), false);
  assert.match(artifacts, /TypeError: current launch failure/);
  const summary = JSON.parse(await readFile(path.join(result.directory, "diagnostics.json"), "utf8"));
  assert.equal(summary.logs.find(item => item.path === main).retained, false);
  assert.equal(summary.logs.find(item => item.path.endsWith("main.old.log")).offset, Buffer.byteLength("PRIOR_LAUNCH_PRIVATE_CONTENT\n"));
  assert.equal(summary.processes.unavailable, true);
  assert.equal(summary.windows.unavailable, true);
}));

test("an exited synthetic app cannot authorize reading reused or registered PIDs' window text", () => fixture(async (base, logs) => {
  const logBaseline = await snapshotStartupLogs([logs]);
  let windowReads = 0;
  const result = await collectStartupFailure({ ...base, startedAt: Date.now(), logBaseline,
    child: { ...base.child, exitCode: 1 },
    processSnapshot: () => [{ pid: base.child.pid, parentPid: 0, name: "reused-PID" }],
    windowSnapshot: () => { windowReads++; throw new Error("Must not inspect a dead app's windows"); },
  });
  const summary = JSON.parse(await readFile(path.join(result.directory, "diagnostics.json"), "utf8"));
  assert.equal(windowReads, 0);
  assert.deepEqual(summary.windows, { skipped: true, reason: "synthetic-main-process-not-live" });
}));

test("cookie headers and password assignments are scrubbed independently of known config values", () => {
  const value = scrubStartupText('Cookie: session=unknown-cookie\nSet-Cookie: auth=unknown-set-cookie; Secure\npassword="unknown-password"\nError: useful detail');
  for (const secret of ["unknown-cookie", "unknown-set-cookie", "unknown-password"]) assert.equal(value.includes(secret), false);
  assert.match(value, /Error: useful detail/);
});
