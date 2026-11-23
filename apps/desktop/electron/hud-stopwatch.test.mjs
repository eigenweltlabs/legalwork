import assert from "node:assert/strict";
import { test } from "node:test";
import { HudStopwatch, requestHudStopwatch } from "./audio/hud-stopwatch.mjs";

test("restores authoritative time, reconciles lost replies and ignores superseded controls", async () => {
  let state = { profileId: "first", active: null, lastStopped: null, matters: [{id: "m", name: "Matter"}] };
  let loseReply = false;
  let failStart = true;
  const writes = [];
  const request = async (action, profileId) => {
    if (!action) return structuredClone(state);
    assert.equal(profileId, state.profileId);
    writes.push(action);
    if (failStart) throw Error("offline");
    if (action.type === "start")
      state.active = { id: action.id, matterId: action.matterId, startedAt: "2026-11-14T10:00:00Z" };
    else {
      assert.equal(action.id, state.active.id);
      state.lastStopped = { id: action.id, date: "2026-11-14", stoppedAt: "2026-11-14T11:00:00Z" };
      state.active = null;
    }
    if (loseReply) throw Error("lost reply");
    return structuredClone(state);
  };
  const observed = [];
  const watch = new HudStopwatch(request, (value) => observed.push(value));
  await watch.refresh();
  await watch.act("start", watch.version, "m");
  assert.ok(observed.at(-1).failed);
  failStart = false;
  loseReply = true;
  await watch.act("start", watch.version, "m");
  assert.equal(writes[1].id, writes[0].id);
  assert.equal(observed.at(-1).startedAt, "2026-11-14T10:00:00Z");
  const restored = new HudStopwatch(request, (value) => observed.push(value));
  await restored.refresh();
  assert.equal(observed.at(-1).startedAt, "2026-11-14T10:00:00Z");
  await restored.act("stop", restored.version);
  assert.ok(observed.at(-1).savedUntil > Date.now());
  assert.equal(observed.at(-1).startedAt, null);
  const oldVersion = restored.version;
  state = { ...state, profileId: "second" };
  await restored.refresh();
  await restored.act("start", oldVersion);
  assert.equal(writes.length, 3);
  assert.equal(observed.at(-1).savedUntil, 0);
  assert.equal("profileId" in observed.at(-1), false);
});

test("private stopwatch refuses remote or non-host connections before transport", async () => {
  const info = { running: true, baseUrl: "https://example.invalid", ownerToken: "fixture", hostToken: "fixture" };
  await assert.rejects(requestHudStopwatch(info), /local server/);
  await assert.rejects(requestHudStopwatch({ ...info, baseUrl: "http://127.0.0.1", hostToken: null }), /unavailable/);
});


test("matter reassignment reconciles a lost reply and prevents a stale stop", async () => {
  const state = {
    profileId: "fixture",
    matters: [{ id: "one", name: "First" }, { id: "two", name: "Second" }],
    active: { id: "run", matterId: "one", startedAt: "2026-11-17T10:00:00Z" },
    lastStopped: null,
  };
  const writes = [];
  const observed = [];
  const watch = new HudStopwatch(async action => {
    if (action) {
      writes.push(action);
      state.active.matterId = action.matterId ?? null;
      throw Error("Lost reply after committed assignment");
    }
    return structuredClone(state);
  }, value => observed.push(value));
  await watch.refresh();
  const oldVersion = watch.version;
  await watch.act("assign", oldVersion, "unknown");
  assert.equal(writes.length, 0);
  await watch.act("assign", oldVersion, "two");
  assert.equal(observed.at(-1).matterId, "two");
  assert.equal(observed.at(-1).failed, false);
  await watch.act("stop", oldVersion);
  assert.equal(writes.length, 1);
  await watch.act("assign", watch.version);
  assert.equal(observed.at(-1).matterId, "two");
  assert.equal(observed.at(-1).failed, false);
});

test("turning time tracking off hides the idle control and lets a running timer finish", async () => {
  const active = { id: "run", matterId: "m", startedAt: "2026-11-17T10:00:00Z" };
  const state = { profileId: "profile", enabled: false, active, matters: [{ id: "m", name: "Matter" }] };
  const writes = [], observed = [];
  const hud = new HudStopwatch(async action => {
    if (action) { writes.push(action); state.active = null; }
    return structuredClone(state);
  }, value => observed.push(value));
  await hud.refresh();
  assert.equal(observed.at(-1).enabled, false);
  await hud.act("assign", hud.version, "m");
  await hud.act("stop", hud.version);
  assert.equal(observed.at(-1), null);
  await hud.act("start", hud.version, "m");
  assert.deepEqual(writes, [{ type: "stop", id: active.id }]);
});

test("opening the matter picker during a status poll still loads the directory", async () => {
  const pending = Promise.withResolvers();
  const reads = [];
  const state = { profileId: "p", active: null, lastStopped: null };
  const matter = { id: "matter", name: "Lease" };
  const watch = new HudStopwatch(async (_action, _profile, includeMatters) => {
    reads.push(includeMatters);
    if (!includeMatters) await pending.promise;
    return includeMatters ? { ...state, matters: [matter] } : state;
  }, () => {});
  const status = watch.refresh();
  const first = watch.refresh(true), second = watch.refresh(true);
  pending.resolve();
  await Promise.all([status, first, second]);
  assert.deepEqual(reads, [false, true]);
  assert.deepEqual(watch.state.matters, [matter]);
});
