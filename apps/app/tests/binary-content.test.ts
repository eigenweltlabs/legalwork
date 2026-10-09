import { expect, test } from "bun:test";
import { binaryMatchesStat, retainBinaryContent } from "../src/react-app/domains/session/artifacts/binary-content";

test("unchanged polls retain preview bytes while real changes replace them", () => {
  const original = new Uint8Array([1, 2, 3]).buffer;
  const repeated = new Uint8Array([1, 2, 3]).buffer;
  expect(retainBinaryContent(original, repeated)).toBe(original);
  const changed = new Uint8Array([1, 4, 3]).buffer;
  expect(retainBinaryContent(original, changed)).toBe(changed);
  const resized = new Uint8Array([1, 2]).buffer;
  expect(retainBinaryContent(original, resized)).toBe(resized);
  expect(retainBinaryContent(undefined, repeated)).toBe(repeated);
});

test("stat skips only unchanged downloads with a response timestamp and matching size", () => {
  const cached = { data: new ArrayBuffer(3), downloadedUpdatedAt: 123.456 };
  const stat = { exists: true, kind: "file", size: 3, updatedAt: 123.456 };
  expect(binaryMatchesStat(cached, stat)).toBe(true);
  expect(binaryMatchesStat(cached, { ...stat, updatedAt: 124 })).toBe(false);
  expect(binaryMatchesStat(cached, { ...stat, size: 4 })).toBe(false);
  expect(binaryMatchesStat(cached, { ...stat, exists: false })).toBe(false);
  expect(binaryMatchesStat(cached, { ...stat, kind: "dir" })).toBe(false);
  expect(binaryMatchesStat({ data: cached.data }, stat)).toBe(false);
  expect(binaryMatchesStat({ ...cached, downloadedUpdatedAt: null }, stat)).toBe(false);
  expect(binaryMatchesStat(cached, { ...stat, updatedAt: undefined })).toBe(false);
  expect(binaryMatchesStat(cached, { ...stat, size: undefined })).toBe(false);
});
