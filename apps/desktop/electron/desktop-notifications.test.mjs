import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { notificationIcon, showNativeNotification } from "./desktop-notifications.mjs";

test("notification icons accept embedded PNGs and reject file paths, URLs, oversized and broken images", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const resized = {};
  const nativeImage = { createFromDataURL: value => {
    assert.equal(value, png);
    return { isEmpty: () => false, resize: size => { assert.deepEqual(size, { width: 128, height: 128 }); return resized; } };
  } };
  assert.equal(notificationIcon(png, nativeImage), resized);
  for (const invalid of [undefined, "/tmp/fox.png", "https://example.com/fox.png", "data:image/svg+xml;base64,AAAA", `${png}${"A".repeat(128 * 1024)}`]) {
    assert.equal(notificationIcon(invalid, nativeImage), undefined);
  }
  assert.equal(notificationIcon(png, { createFromDataURL: () => ({ isEmpty: () => true }) }), undefined);
  assert.equal(notificationIcon(png, { createFromDataURL: () => { throw new Error("Invalid image"); } }), undefined);
});

test("delivery waits for native confirmation, instead of assuming show() succeeded", async () => {
  const notification = Object.assign(new EventEmitter(), { show: () => queueMicrotask(() => notification.emit("show")) });
  assert.equal(await showNativeNotification(notification), true);
  assert.equal(notification.listenerCount("failed"), 0);
});

test("native errors and missing delivery confirmation return false and release the notification", async () => {
  for (const failure of ["event", "throw", "timeout"]) {
    const notification = Object.assign(new EventEmitter(), { show() {} });
    let released = false;
    const warnings = [];
    notification.show = () => {
      if (failure === "throw") throw new Error("Unavailable");
      if (failure === "event") queueMicrotask(() => notification.emit("failed", {}, "Notifications are not allowed"));
    };
    assert.equal(await showNativeNotification(notification, {
      onFailure: () => { released = true; },
      logger: { ...console, warn: (...args) => { warnings.push(args); } },
      timeoutMs: 5,
    }), false);
    assert.equal(released, true);
    assert.equal(warnings.length, 1);
    assert.equal(notification.listenerCount("show"), 0);
    assert.equal(notification.listenerCount("failed"), 0);
  }
});
