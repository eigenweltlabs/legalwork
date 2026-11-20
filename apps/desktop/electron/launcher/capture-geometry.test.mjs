import assert from "node:assert/strict";
import test from "node:test";
import { capturePixelRect, displayCaptureSource } from "./capture-geometry.mjs";

test("capture uses the exact display; multiple or mismatched sources are rejected", () => {
  const primary = { display_id: "12" };
  const external = { display_id: "34" };
  assert.equal(displayCaptureSource([primary, external], 34, 2), external);
  assert.equal(displayCaptureSource([primary, external], 56, 2), null);
  assert.equal(displayCaptureSource([external, external], 34, 2), null);
  assert.equal(displayCaptureSource([primary], 34, 1), null);
  const unlabelled = { display_id: "" };
  assert.equal(displayCaptureSource([unlabelled], 34, 2), null);
  assert.equal(displayCaptureSource([unlabelled], 34, 1), unlabelled);
});

test("region follows actual thumbnail pixels on a scaled display and clamps at its edge", () => {
  const display = { width: 1600, height: 900 };
  const thumbnail = { width: 3000, height: 1688 };
  assert.deepEqual(capturePixelRect({ x: 800, y: 450, width: 801, height: 451 }, display, thumbnail), { x: 1500, y: 844, width: 1500, height: 844 });
  assert.deepEqual(capturePixelRect({ x: 1596, y: 896, width: 4, height: 4 }, display, thumbnail), { x: 2992, y: 1680, width: 8, height: 8 });
  assert.equal(capturePixelRect({ x: 1601, y: 900, width: 10, height: 10 }, display, thumbnail), null);
});
