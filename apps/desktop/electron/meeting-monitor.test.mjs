import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingMonitor, meetingCandidate } from "./audio/meeting-monitor.mjs";

const zoom = { bundleId: "us.zoom.xos", inputActive: true, documents: [] };
const browser = (url, title = "", inputActive = true) => ({ bundleId: "com.google.Chrome.helper", inputActive, documents: [{ url, title }] });

test("native calls need microphone activity; playback and LegalWork never trigger detection", () => {
  for (const bundleId of ["us.zoom.xos", "com.microsoft.teams2", "com.tinyspeck.slackmacgap", "com.cisco.webexmeetingsapp"]) {
    assert.ok(meetingCandidate([{ bundleId, inputActive: true }]));
    assert.equal(meetingCandidate([{ bundleId, inputActive: false }]), null);
  }
  assert.equal(meetingCandidate([{ bundleId: "com.eigenweltlabs.legalwork", inputActive: true }, null]), null);
});

test("browser calls require a provider meeting URL or call title as well as microphone activity", () => {
  for (const url of ["https://meet.google.com/abc-defg-hij?authuser=1", "https://teams.microsoft.com/l/meetup-join/123", "https://teams.live.com/meet/123", "https://us02web.zoom.us/wc/123/join"]) {
    const match = meetingCandidate([browser(url)]);
    assert.ok(match, url);
    assert.ok(!match.id.includes("authuser"), "account and URL query parameters are not retained");
    assert.equal(meetingCandidate([browser(url, "", false)]), null);
  }
  assert.equal(meetingCandidate([browser("https://youtube.com", "Google Meet tutorial")]), null);
  assert.equal(meetingCandidate([browser("https://meet.google.com/")]), null);
  assert.equal(meetingCandidate([browser("https://meet.google.com.evil.test/abc-defg-hij")]), null);
  assert.equal(meetingCandidate([browser("", "Meet – abc-defg-hij")])?.app, "Google Meet");
  assert.equal(meetingCandidate([browser("https://example.com", "Ordinary browser recording")]), null);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legalwork-meeting-test-"));
  let time = 1000;
  let result = { supported: true, processes: [zoom] };
  const changes = [], starts = [];
  const monitor = new MeetingMonitor({ app: { getPath: () => directory }, now: () => time,
    probe: async () => result, onChange: value => changes.push(value), onStart: title => starts.push(title) });
  t.after(async () => { monitor.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { monitor, directory, changes, starts, advance: ms => { time += ms; }, signal: processes => { result = { supported: true, processes }; } };
}

test("a stable call offers a prompt, never starts recording by itself, and survives brief muting", async t => {
  const f = await fixture(t);
  await f.monitor.poll();
  assert.equal(f.monitor.status().detected, null);
  f.advance(3000); await f.monitor.poll();
  assert.equal(f.monitor.status().detected.app, "Zoom");
  assert.deepEqual(f.starts, []);
  f.signal([]); f.advance(6000); await f.monitor.poll();
  assert.ok(f.monitor.status().detected);
  f.advance(9000); await f.monitor.poll();
  assert.equal(f.monitor.status().detected, null);
});

test("dismissing a call suppresses repeat prompts until the call has ended", async t => {
  const f = await fixture(t);
  await f.monitor.poll(); f.advance(3000); await f.monitor.poll();
  f.monitor.dismiss(); f.advance(3000); await f.monitor.poll();
  assert.equal(f.monitor.status().detected, null);
  f.signal([]); f.advance(15000); await f.monitor.poll();
  f.signal([zoom]); await f.monitor.poll(); f.advance(3000); await f.monitor.poll();
  assert.ok(f.monitor.status().detected);
});

test("repeated Record clicks start once; saving cannot start another recording", async t => {
  const f = await fixture(t);
  await f.monitor.poll(); f.advance(3000); await f.monitor.poll();
  f.monitor.requestStart(); f.monitor.requestStart();
  assert.deepEqual(f.starts, ["Zoom"]);
  f.monitor.setRecording({ state: "recording", recordingId: "retained", startedAt: 4000 });
  assert.equal(f.monitor.status().detected, null);
  f.monitor.setRecording({ state: "saving" }); f.monitor.requestStart();
  assert.equal(f.starts.length, 1);
  f.monitor.setRecording({ state: "idle", error: null });
  assert.equal(f.monitor.status().recordingId, null);
  assert.equal(f.monitor.status().startedAt, null);
  await f.monitor.poll(); assert.equal(f.monitor.status().detected, null);
});

test("disabling detection rejects an in-flight probe and persists across restart", async t => {
  const f = await fixture(t);
  let resolve = (_value) => {};
  f.monitor.probe = () => new Promise(done => { resolve = done; });
  const poll = f.monitor.poll();
  await f.monitor.setDetection(false);
  resolve({ supported: true, processes: [zoom] }); await poll;
  assert.equal(f.monitor.status().detected, null);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, "meeting-detection.json"), "utf8")).detectionEnabled, false);
  const second = new MeetingMonitor({ app: { getPath: () => f.directory }, onChange() {}, onStart() {}, probe: async () => { throw new Error("disabled detection must not probe"); } });
  t.after(() => second.dispose());
  await second.initialize(); assert.equal(second.status().detectionEnabled, false);
});

test("unsupported detection keeps manual meeting recording available", async t => {
  const f = await fixture(t);
  f.monitor.probe = async () => ({ supported: false, processes: [] });
  await f.monitor.poll(); assert.equal(f.monitor.status().detectionSupported, false);
  f.monitor.requestStart(); assert.equal(f.starts.length, 1);
});
