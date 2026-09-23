// The parent owns the profile: Windows keeps Chromium files locked until the
// Electron process exits, so deleting them inside Electron can hang the test.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const userData = await mkdtemp(path.join(tmpdir(), "legalwork-preview-security-"));
const child = spawn(electron, [...process.argv.slice(2), fileURLToPath(new URL("preview-security-regression.mjs", import.meta.url))], {
  env: { ...process.env, LEGALWORK_PREVIEW_TEST_USERDATA: userData },
  stdio: "inherit",
});
const timeout = setTimeout(() => {
  console.error("Preview security test exceeded 30 seconds");
  child.kill("SIGKILL");
}, 30_000);
try {
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  clearTimeout(timeout);
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
