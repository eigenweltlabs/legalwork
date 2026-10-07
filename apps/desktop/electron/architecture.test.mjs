import assert from "node:assert/strict";
import test from "node:test";
import { architectureInfo, findArchitectureDownload, resolveSystemArch } from "./architecture.mjs";

test("detects Windows ARM64 when x64 emulation reports x64 everywhere else", () => {
  const systemArch = resolveSystemArch({ platform: "win32", appArch: "x64", machine: "x86_64", env: { PROCESSOR_ARCHITECTURE: "AMD64" }, translated: true });
  assert.equal(systemArch, "arm64");
  const info = architectureInfo({ platform: "win32", appArch: "x64", systemArch, version: "0.2.4", releaseUrl: "https://example.com/releases" });
  assert.equal(info.mismatch, true);
  assert.equal(info.downloadUrl, null); // Never invent an installer that may not exist.
  assert.equal(info.systemArchLabel, "ARM64");
});

test("native builds and macOS Rosetta resolve their system architecture", () => {
  for (const [platform, machine, expected] of [["win32", "AMD64", "x64"], ["win32", "ARM64", "arm64"], ["linux", "aarch64", "arm64"], ["darwin", "arm64", "arm64"]]) {
    const systemArch = resolveSystemArch({ platform, machine, appArch: expected });
    assert.equal(systemArch, expected);
    assert.equal(architectureInfo({ platform, systemArch, appArch: expected, version: "1", releaseUrl: "" }).mismatch, false);
  }
  assert.equal(resolveSystemArch({ platform: "darwin", machine: "x86_64", appArch: "x64", translated: true }), "arm64");
});

const feeds = ["https://primary.example/stable", "https://fallback.example/latest/download"];
test("an x64-only release never offers an x64 installer to an ARM64 machine", async () => {
  const result = await findArchitectureDownload({ platform: "win32", arch: "arm64", feeds,
    fetchImpl: async () => new Response("files:\n  - url: legalwork-win-x64-0.2.4.exe\n") });
  assert.deepEqual(result, { status: "unavailable", downloadUrl: null });
});

test("uses a real architecture-matching installer from a fallback feed", async () => {
  const requested = [];
  const result = await findArchitectureDownload({ platform: "win32", arch: "arm64", feeds,
    fetchImpl: async (url) => {
      requested.push(url);
      return requested.length === 1 ? new Response("missing", { status: 404 }) : new Response("files:\n  - url: legalwork-win-x64-1.exe\n  - url: legalwork-win-arm64-1.exe.blockmap\n  - url: 'legalwork-win-arm64-1.exe'\n");
    } });
  assert.equal(requested.length, 2);
  assert.deepEqual(result, { status: "available", downloadUrl: `${feeds[1]}/legalwork-win-arm64-1.exe` });
});

test("offline requests are bounded and leave the current app usable", async () => {
  // AbortSignal.timeout is unref'd; keep the test alive while exercising cancellation.
  const keepAlive = setInterval(() => {}, 1000);
  let aborted = 0;
  try {
    const result = await findArchitectureDownload({ platform: "win32", arch: "arm64", feeds, timeoutMs: 10,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true })) });
    assert.equal(aborted, 2);
    assert.deepEqual(result, { status: "error", downloadUrl: null });
  } finally { clearInterval(keepAlive); }
});
