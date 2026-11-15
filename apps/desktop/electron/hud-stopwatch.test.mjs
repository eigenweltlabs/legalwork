import assert from "node:assert/strict";
import { test } from "node:test";
import { HudStopwatch, requestHudStopwatch } from "./audio/hud-stopwatch.mjs";

test("restores authoritative time, reconciles lost replies and ignores superseded controls", async () => {
  let state = { profileId: "first", active: null, lastStopped: null };
  let loseReply = false;
  let failStart = true;
  const writes = [];
  const request = async (action, profileId) => {
    if (!action) return structuredClone(state);
    assert.equal(profileId, state.profileId);
    writes.push(action);
    if (failStart) throw Error("offline");
    if (action.type === "start")
      state.active = { id: action.id, startedAt: "2026-11-14T10:00:00Z" };
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
  await watch.act("start", watch.version);
  assert.ok(observed.at(-1).failed);
  failStart = false;
  loseReply = true;
  await watch.act("start", watch.version);
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
