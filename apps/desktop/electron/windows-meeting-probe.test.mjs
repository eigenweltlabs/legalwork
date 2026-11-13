import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MeetingMonitor, meetingCandidate } from "./audio/meeting-monitor.mjs";
import { WindowsMeetingProbe, WINDOWS_MEETING_SCRIPT, windowsMeetingProcesses } from "./audio/windows-meeting-probe.mjs";

const zoom = { executable: "Zoom.exe", inputActive: true, documents: [] };
const chrome = (url, title = "") => ({ executable: "chrome.exe", inputActive: true, documents: [{ title, url }] });
const empty = { supported: false, processes: [] };

test("Windows call applications use the existing provider and microphone-activity rules", () => {
  for (const [executable, provider] of [["Zoom.exe", "Zoom"], ["Teams.exe", "Microsoft Teams"], ["MS-TEAMS.EXE", "Microsoft Teams"], ["slack.exe", "Slack"], ["CiscoCollabHost.exe", "Webex"], ["atmgr.exe", "Webex"]]) {
    const process = { executable, inputActive: true };
    assert.equal(meetingCandidate(windowsMeetingProcesses([process]))?.app, provider);
    assert.equal(meetingCandidate(windowsMeetingProcesses([{ ...process, inputActive: false }])), null);
  }
  assert.deepEqual(windowsMeetingProcesses([{ executable: "LegalWork.exe", inputActive: true }, { executable: "audiodg.exe", inputActive: true }, { executable: "zoom.exe.evil", inputActive: true }, null]), []);
  assert.deepEqual(windowsMeetingProcesses({ processes: [zoom] }), []);
});

test("Windows browser provider names require meeting metadata; microphone-only activity offers a generic call", () => {
  for (const executable of ["chrome.exe", "msedge.exe", "firefox.exe"]) {
    const process = { ...chrome("https://meet.google.com/abc-defg-hij?authuser=1"), executable };
    const match = meetingCandidate(windowsMeetingProcesses([process]));
    assert.equal(match?.app, "Google Meet");
    assert.ok(!match.id.includes("authuser"));
    assert.equal(meetingCandidate(windowsMeetingProcesses([{ ...process, inputActive: false }])), null);
  }
  assert.equal(meetingCandidate(windowsMeetingProcesses([chrome("https://teams.microsoft.com/l/meetup-join/123")]))?.app, "Microsoft Teams");
  assert.equal(meetingCandidate(windowsMeetingProcesses([chrome("https://us02web.zoom.us/wc/123/join")]))?.app, "Zoom");
  assert.equal(meetingCandidate(windowsMeetingProcesses([chrome("", "Meet - abc-defg-hij - Google Chrome")]))?.app, "Google Meet");
  for (const value of [chrome("https://youtube.com", "Google Meet tutorial"), chrome("https://meet.google.com/"), chrome("https://meet.google.com.evil.test/abc-defg-hij"), chrome("", "Microsoft Teams - Home"), { ...chrome("https://example.com"), documents: [null, { url: 3 }] }]) {
    assert.equal(meetingCandidate(windowsMeetingProcesses([value]))?.app, "Browser call");
    assert.equal(meetingCandidate(windowsMeetingProcesses([{ ...value, inputActive: false }])), null);
  }
});

function fixture(t, options = {}) {
  const children = [], commands = [], packets = [];
  let time = 0;
  const probe = new WindowsMeetingProbe({
    startupTimeoutMs: 100, pollTimeoutMs: 100, retryDelayMs: 1000, now: () => time, ...options,
    spawn(file, args, spawnOptions) {
      const child = new ChildProcess();
      const output = new PassThrough();
      child.stdin = new PassThrough(); child.stdout = output; child.stderr = new PassThrough();
      let kills = 0;
      child.kill = () => { kills++; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
      child.stdin.on("data", value => packets.push(value.toString()));
      children.push({ child, ready: () => output.write("ready\r\n"), result: value => output.write(JSON.stringify(value) + "\n"), kills: () => kills });
      commands.push({ file, args, options: spawnOptions });
      return child;
    },
  });
  t.after(() => probe.dispose());
  return { probe, children, commands, packets, advance: ms => { time += ms; } };
}

test("one hidden helper handles repeated and concurrent polls without recompiling", async t => {
  const f = fixture(t);
  const first = f.probe.poll();
  assert.equal(f.probe.poll(), first);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.packets, [], "wait for compilation readiness before requesting metadata");
  assert.ok(f.commands[0].file.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe"));
  assert.equal(f.commands[0].options.windowsHide, true);
  assert.ok(f.commands[0].args.includes("-Mta"));
  assert.ok(!f.commands[0].args.includes("Bypass"), "do not weaken PowerShell policy");
  f.children[0].ready();
  assert.deepEqual(f.packets, ["poll\n"]);
  f.children[0].result({ supported: true, processes: [zoom] });
  assert.equal(meetingCandidate((await first).processes)?.app, "Zoom");
  const second = f.probe.poll();
  f.children[0].result({ supported: true, processes: [] });
  assert.deepEqual(await second, { supported: true, processes: [] });
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.packets, ["poll\n", "poll\n"]);
});

test("chunked UTF-8 and CRLF metadata is assembled before matching a browser call", async t => {
  const f = fixture(t);
  const poll = f.probe.poll();
  const output = "ready\r\n" + JSON.stringify({ supported: true, processes: [chrome("", "Meet – abc-defg-hij")] }) + "\r\n";
  const bytes = Buffer.from(output);
  const split = bytes.indexOf(Buffer.from("–")) + 1;
  f.children[0].child.stdout.write(bytes.subarray(0, split));
  f.children[0].child.stdout.write(bytes.subarray(split));
  assert.equal(meetingCandidate((await poll).processes)?.app, "Google Meet");
});

test("a dead or blocked helper settles the poll, backs off, and can recover", async t => {
  const f = fixture(t);
  const poll = f.probe.poll();
  f.children[0].child.emit("error", new Error("PowerShell unavailable"));
  assert.deepEqual(await poll, empty);
  assert.deepEqual(await f.probe.poll(), empty);
  assert.equal(f.children.length, 1, "do not spawn a compiler every three seconds after failure");
  f.advance(1000);
  const recovered = f.probe.poll();
  f.children[1].ready(); f.children[1].result({ supported: true, processes: [zoom] });
  assert.equal((await recovered).supported, true);
});

test("startup and UI Automation stalls time out and release their helper", async t => {
  const f = fixture(t, { startupTimeoutMs: 15, pollTimeoutMs: 15 });
  assert.deepEqual(await f.probe.poll(), empty);
  assert.equal(f.children[0].kills(), 1);
  f.advance(1000);
  const stalled = f.probe.poll();
  f.children[1].ready();
  assert.deepEqual(await stalled, empty);
  assert.equal(f.children[1].kills(), 1);
});

test("malformed or oversized replies cannot inject a detected call", async t => {
  for (const output of ['not-json\n', '{"supported":true,"processes":{}}\n', 'x'.repeat(128 * 1024 + 1)]) {
    const f = fixture(t);
    const poll = f.probe.poll(); f.children[0].ready(); f.children[0].child.stdout.write(output);
    assert.deepEqual(await poll, empty);
    assert.equal(f.children[0].kills(), 1);
  }
});

test("stopping settles in-flight work and stale exits cannot stop a new helper", async t => {
  const f = fixture(t);
  const cancelled = f.probe.poll();
  f.probe.dispose();
  assert.deepEqual(await cancelled, empty);
  const next = f.probe.poll();
  f.children[0].ready(); f.children[0].child.emit("exit", 1, null);
  await Promise.resolve();
  f.children[1].ready(); f.children[1].result({ supported: true, processes: [zoom] });
  assert.equal((await next).supported, true);
  assert.equal(f.children[1].kills(), 0);
});

test("Windows metadata uses the shared prompt, dismissal, disable, and suspend lifecycle", async t => {
  const f = fixture(t);
  const starts = [];
  let time = 0;
  const monitor = new MeetingMonitor({ app: { getPath: () => "." }, platform: "win32", now: () => time, onChange() {}, onStart: title => starts.push(title) });
  assert.ok(monitor.windowsProbe instanceof WindowsMeetingProbe);
  // Exercise the Windows factory while replacing only its child process transport.
  monitor.windowsProbe = f.probe;
  t.after(() => monitor.dispose());
  const first = monitor.poll(); f.children[0].ready(); f.children[0].result({ supported: true, processes: [zoom] }); await first;
  assert.equal(monitor.status().detected, null);
  time = 3000;
  const stable = monitor.poll(); f.children[0].result({ supported: true, processes: [zoom] }); await stable;
  assert.equal(monitor.status().detected?.app, "Zoom");
  assert.deepEqual(starts, [], "recognition offers a prompt without recording");
  monitor.dismiss();
  const dismissed = monitor.poll(); f.children[0].result({ supported: true, processes: [zoom] }); await dismissed;
  assert.equal(monitor.status().detected, null);
  monitor.reset();
  assert.equal(f.children[0].kills(), 1);
  const resumed = monitor.poll(); f.children[1].ready(); f.children[1].result({ supported: true, processes: [zoom] }); await resumed;
  const disabledPoll = monitor.poll();
  // Avoid writing a real settings file: disabling uses a disposable test directory below.
  monitor.settingsPath = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", `legalwork-meeting-${process.pid}-${Date.now()}.json`);
  const { rm } = await import("node:fs/promises");
  t.after(() => rm(monitor.settingsPath, { force: true }));
  await monitor.setDetection(false);
  await disabledPoll;
  assert.equal(f.children[1].kills(), 1);
  assert.equal(monitor.status().detected, null);
  await monitor.poll(); assert.equal(f.children.length, 2);
});

test("production Windows helper compiles and queries Core Audio without capturing", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = await new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-Command", WINDOWS_MEETING_SCRIPT], { windowsHide: true, timeout: 25000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Windows meeting helper failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
    child.stdin.end("poll\n");
  });
  const lines = String(output).trim().split(/\r?\n/);
  assert.equal(lines[0], "ready", "compile the exact helper shipped with the app");
  assert.equal(lines.length, 2);
  const result = JSON.parse(lines[1]);
  assert.equal(typeof result.supported, "boolean");
  assert.ok(Array.isArray(result.processes));
  for (const process of result.processes) {
    assert.equal(process.inputActive, true);
    assert.ok(windowsMeetingProcesses([process]).length === 1);
  }
});
