import { expect, test } from "bun:test";
import { matchesDocxRecoveryKey } from "../src/react-app/domains/session/artifacts/docx-recovery";
import { documentIdentityKey } from "../src/react-app/domains/session/artifacts/document-identity";

test("a local original retains its recovery identity across backend ports and loopback aliases", () => {
  const key = documentIdentityKey("http://127.0.0.1:4000", "file-a", true);
  for (const url of ["http://127.0.0.1:5000", "http://localhost:5000", "http://[::1]:5000/"]) {
    expect(documentIdentityKey(url, "file-a", true)).toBe(key);
    expect(matchesDocxRecoveryKey(JSON.stringify([url, "file-a"]), key)).toBe(true);
  }
  expect(documentIdentityKey("http://localhost:5000", "file-b", true)).not.toBe(key);
});

test("recovery never joins unrelated remote servers or proxy routes", () => {
  const local = documentIdentityKey("http://localhost:4000", "file-a", true);
  const remote = documentIdentityKey("https://example.test:4000", "file-a", false);
  for (const url of ["https://example.test:5000", "https://other.test:4000", "http://localhost:4000/remote", "http://127.0.0.1.evil.test:4000"]) {
    expect(documentIdentityKey(url, "file-a", false)).not.toBe(local);
    expect(documentIdentityKey(url, "file-a", false)).not.toBe(remote);
    expect(matchesDocxRecoveryKey(JSON.stringify([url, "file-a"]), local)).toBe(false);
  }
  expect(matchesDocxRecoveryKey(JSON.stringify(["https://example.test:4000", "file-a"]), remote)).toBe(true);
});

test("migration accepts the explicit former workspace/path key but rejects unrelated and malformed records", () => {
  const key = documentIdentityKey("http://localhost:5000", "file-a", true);
  const legacy = JSON.stringify(["workspace-a", "Agreement.docx"]);
  expect(matchesDocxRecoveryKey(key, key, legacy)).toBe(true);
  expect(matchesDocxRecoveryKey(legacy, key, legacy)).toBe(true);
  for (const candidate of ["invalid", "null", "{}", "[]", '[1,2]', JSON.stringify(["workspace-b", "Agreement.docx"]), JSON.stringify(["http://localhost:4000", "file-b"])]) {
    expect(matchesDocxRecoveryKey(candidate, key, legacy)).toBe(false);
  }
});

test("loopback URLs alone never identify remote workers as the local machine", () => {
  const local = documentIdentityKey("http://localhost:5000", "file-a", true);
  const remoteA = documentIdentityKey("http://localhost:5000", "file-a", false);
  const remoteB = documentIdentityKey("http://localhost:6000", "file-a", false);
  expect(new Set([local, remoteA, remoteB]).size).toBe(3);
  expect(matchesDocxRecoveryKey(remoteB, remoteA)).toBe(false);
});
