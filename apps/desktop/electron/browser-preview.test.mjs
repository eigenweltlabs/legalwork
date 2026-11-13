import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installBrowserPreview } from "./browser-preview.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const page = () => Object.assign(new EventEmitter(), { getURL: () => "https://fixture.test/" });

test("slow navigation stays outside capture work; ready/load events merge and an idle page does not poll", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const contents = page(), images = [];
  let captures = 0;
  const preview = installBrowserPreview(contents, { enabled: () => true, busy: () => false,
    capture: async () => ++captures, publish: image => images.push(image) });
  t.after(preview.dispose);
  contents.emit("did-start-navigation", { isMainFrame: true });
  t.mock.timers.tick(60000); await flush();
  assert.equal(captures, 0);
  contents.emit("dom-ready");
  t.mock.timers.tick(200);
  contents.emit("did-finish-load");
  t.mock.timers.tick(299); await flush();
  assert.equal(captures, 0);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(images, [1]);
  t.mock.timers.tick(60000); await flush();
  assert.equal(captures, 1);
  contents.emit("did-navigate-in-page", { isMainFrame: false });
  t.mock.timers.tick(300); await flush();
  assert.equal(captures, 1);
  contents.emit("did-navigate-in-page", { isMainFrame: true });
  t.mock.timers.tick(300); await flush();
  assert.deepEqual(images, [1, 2]);
});

test("busy input defers one refresh; redirects discard old captures and closing cancels pending work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const contents = page(), images = [], active = [];
  let busy = true, starts = 0;
  const preview = installBrowserPreview(contents, { enabled: () => true, busy: () => busy,
    capture: signal => { starts++; return new Promise(resolve => active.push({ resolve, signal })); },
    publish: image => images.push(image) });
  t.after(preview.dispose);
  for (let i = 0; i < 4; i++) {
    contents.emit("dom-ready"); contents.emit("did-finish-load");
    t.mock.timers.tick(500); await flush();
  }
  assert.equal(starts, 0);
  busy = false;
  t.mock.timers.tick(300); await flush();
  assert.equal(starts, 1);
  contents.emit("did-start-navigation", { isMainFrame: true });
  contents.emit("did-redirect-navigation", { isMainFrame: true });
  active[0].resolve("old page"); await flush();
  assert.deepEqual(images, []);
  contents.emit("dom-ready");
  t.mock.timers.tick(300); await flush();
  contents.emit("did-finish-load"); // Arrives during the first partial-page capture.
  active[1].resolve("partial page"); await flush();
  t.mock.timers.tick(300); await flush();
  assert.equal(starts, 3);
  assert.deepEqual(images, ["partial page"]);
  contents.emit("destroyed");
  assert.equal(active[2].signal.aborted, true);
  active[2].resolve("late image"); await flush();
  t.mock.timers.tick(60000); await flush();
  assert.deepEqual(images, ["partial page"]);
  assert.equal(starts, 3);
  assert.equal(contents.listenerCount("dom-ready"), 0);
});
