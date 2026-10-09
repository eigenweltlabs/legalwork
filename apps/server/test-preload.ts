import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

/**
 * Keeps every test off the real LegalWork profile. A server a test starts
 * without `configPath` falls back to ~/.config/legalwork: the installed app's
 * runtime DB and Eigenwelt sign-in, so its sync rounds ran against the firm
 * with the user's account and dropped their synced projects. Bun reads the
 * home folder once at startup, so homedir() is replaced rather than HOME.
 */
const home = mkdtempSync(join(os.tmpdir(), "legalwork-server-test-home-"));
const homedir = () => home;
mock.module("node:os", () => ({ ...os, homedir, default: { ...os, homedir } }));

// Paths from the shell running the tests could point at the real profile too.
for (const name of [
  "LEGALWORK_SERVER_CONFIG",
  "LEGALWORK_RUNTIME_DB",
  "LEGALWORK_DATA_DIR",
  "LEGALWORK_PROJECTS_DIR",
  "LEGALWORK_BENCHMARKS_DB",
  "LEGALWORK_BENCHMARKS_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]) {
  delete process.env[name];
}
