import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBrowserRegister } from "./prepare-browser-register.mjs";
import { REGISTER_URL, startBrowserRegister } from "./browser-register-fixture.mjs";
import { attachBrowserRegisterEnvironment, verifyBrowserFixtureForward, verifyGuestFixtureProbe } from "./browser-register-environment.mjs";

const config = { hostPort: 39184, guestPort: 39183, tunnelPID: 1234,
  cloud: { instance: "lw-test-arm", project: "project-test", zone: "europe-west3-a" } };
const command = "/opt/google-cloud-sdk/bin/gcloud compute ssh lwcontroller@lw-test-arm --project=project-test --zone=europe-west3-a --tunnel-through-iap -- -N -R 127.0.0.1:39183:127.0.0.1:39184";

test("website transport requires the exact guest, cloud and unambiguous loopback reverse", () => {
  assert.equal(verifyBrowserFixtureForward(config, command).guestURL, REGISTER_URL);
  assert.equal(verifyBrowserFixtureForward(config, command.replace("/opt/google-cloud-sdk/bin/gcloud", "/opt/python /opt/google-cloud-sdk/lib/gcloud.py")).guestURL, REGISTER_URL);
  for (const changed of [command.replace("lwcontroller@lw-test-arm", "lwcontroller@another-arm"),
    command.replace("--project=project-test", "--project=another-project"),
    command.replace("--zone=europe-west3-a", "--zone=us-central1-a"),
    command.replace(":39184", ":39185"), command.replace("-R 127.0.0.1", "-R 0.0.0.0"),
    command + " -R 127.0.0.1:39183:127.0.0.1:39185", command + " -R 127.0.0.1:39183:127.0.0.1:39184",
    command.replace("/opt/google-cloud-sdk/bin/gcloud", "pretend-gcloud")]) assert.throws(() => verifyBrowserFixtureForward(config, changed));
  assert.throws(() => verifyBrowserFixtureForward({ ...config, guestPort: 39186 }, command));
  assert.throws(() => verifyBrowserFixtureForward({ ...config, tunnelPID: 0 }, command));
});

test("actual full website response proves this server instance; another arm or incomplete delivery cannot substitute", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lw-browser-route-"));
  let fixture;
  try {
    const prepared = await prepareBrowserRegister(join(parent, "fixture"));
    fixture = await startBrowserRegister({ directory: prepared.root, port: 0 });
    const nonce = randomUUID(), response = await fetch(fixture.url, { headers: { "x-legalwork-fixture-probe": nonce } });
    const bytes = Buffer.from(await response.arrayBuffer());
    const observed = { status: response.status, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const records = await fixture.snapshot();
    assert.equal(verifyGuestFixtureProbe(records, nonce, observed, fixture.instanceID).responseBytes, bytes.length);
    assert.throws(() => verifyGuestFixtureProbe(records, nonce, observed, "other-arm"));
    assert.throws(() => verifyGuestFixtureProbe(records, "missing", observed, fixture.instanceID));
    assert.throws(() => verifyGuestFixtureProbe([...records, ...records], nonce, observed, fixture.instanceID));
    assert.throws(() => verifyGuestFixtureProbe(records.map(row => ({ ...row, deliveryCompleted: false })), nonce, observed, fixture.instanceID));
    assert.throws(() => verifyGuestFixtureProbe(records, nonce, { ...observed, bytes: bytes.length - 1 }, fixture.instanceID));
    assert.throws(() => verifyGuestFixtureProbe(records, nonce, { ...observed, sha256: "wrong" }, fixture.instanceID));
  } finally { await fixture?.close(); await rm(parent, { recursive: true, force: true }); }
});

test("live wrapper preserves ordinary environment operations and enforces exact task fixture before snapshots", async () => {
  const calls = [], files = {}, fixtureDirectory = "/controller/fixture";
  const environment = { files, async discover() { return this.files; } };
  const fixture = { instanceID: "arm-instance", snapshot: async () => [{ id: "request", fixtureInstanceID: "arm-instance" }] };
  const browserDownloads = async input => input.candidates;
  const wrapped = attachBrowserRegisterEnvironment({ environment, fixture, fixtureDirectory, browserDownloads,
    verifyTransport: async input => { calls.push(input); } });
  const task = { browserFixture: { directory: fixtureDirectory, url: REGISTER_URL } };
  assert.equal(await wrapped.discover(), files);
  assert.equal(wrapped.browserDownloads, browserDownloads);
  assert.deepEqual(await wrapped.browserRegisterRequests({ task, stage: "before", runId: "run" }),
    { instanceID: "arm-instance", requests: [{ id: "request", fixtureInstanceID: "arm-instance" }] });
  await wrapped.browserRegisterRequests({ task, stage: "after", runId: "run" });
  assert.deepEqual(calls.map(item => item.stage), ["before", "after"]);
  for (const wrong of [{ ...task, browserFixture: { ...task.browserFixture, directory: "/other/fixture" } },
    { ...task, browserFixture: { ...task.browserFixture, url: "http://127.0.0.1:9999/register" } }]) await assert.rejects(wrapped.browserRegisterRequests({ task: wrong, stage: "before" }));
  await assert.rejects(wrapped.browserRegisterRequests({ task, stage: "unknown" }));
  assert.equal(calls.length, 2);
});

test("a lost live transport is propagated before any browser task snapshot", async () => {
  let snapshots = 0;
  const wrapped = attachBrowserRegisterEnvironment({ environment: {}, fixtureDirectory: "/controller/fixture",
    fixture: { instanceID: "arm", snapshot: async () => { snapshots++; return []; } },
    verifyTransport: async () => { throw new Error("guest route lost"); }, browserDownloads: async () => [] });
  await assert.rejects(wrapped.browserRegisterRequests({ task: { browserFixture: { directory: "/controller/fixture", url: REGISTER_URL } }, stage: "before" }), /guest route lost/);
  assert.equal(snapshots, 0);
});

test("a route lost during staging prevents the final pre-Send admission despite a successful initial probe", async () => {
  let routeAlive = true, snapshots = 0, sends = 0;
  const task = { browserFixture: { directory: "/controller/fixture", url: REGISTER_URL } };
  const wrapped = attachBrowserRegisterEnvironment({ environment: {}, fixtureDirectory: "/controller/fixture",
    fixture: { instanceID: "arm", snapshot: async () => { snapshots++; return []; } },
    verifyTransport: async () => { if (!routeAlive) throw new Error("route lost after staging"); }, browserDownloads: async () => [] });
  await wrapped.browserRegisterRequests({ task, stage: "before" });
  routeAlive = false;
  await assert.rejects((async () => {
    await wrapped.browserRegisterRequests({ task, stage: "admit" });
    sends++;
  })(), /route lost after staging/);
  assert.equal(snapshots, 1);
  assert.equal(sends, 0);
});
