import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkMailProviderReadiness } from "../provider-config.js";
import { loadGoogleInstalledMailClient, parseGoogleInstalledMailClient, parseGraphMailRegistration } from "./development-config.js";

const installed = { client_id: "123456789-synthetic.apps.googleusercontent.com", project_id: "synthetic-mail-development",
  client_secret: "synthetic_private_client_marker", auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] };

test("standard installed client becomes fixed mail configuration; web/redirect/endpoint substitutions fail safely", () => {
  const settings = parseGoogleInstalledMailClient({ installed });
  expect(checkMailProviderReadiness({ ...settings, clientSecretConfigured: true, redirectUri: "http://127.0.0.1:43123/" }).configurationReady).toBe(true);
  expect(settings.scopes).toEqual(["openid", "email", "https://www.googleapis.com/auth/gmail.modify"]);
  for (const value of [{ web: installed }, { installed: { ...installed, token_uri: "https://attacker.invalid/token" } },
    { installed: { ...installed, redirect_uris: ["https://attacker.invalid/callback"] } },
    { installed: { ...installed, client_secret: "secret\nheader" } }, { installed, additional: "synthetic_private_client_marker" }]) {
    try { parseGoogleInstalledMailClient(value); throw new Error("unexpected acceptance"); }
    catch (error) { expect(error instanceof Error ? error.message : "").toBe("mail_development_config_unavailable"); }
  }
  const graph = parseGraphMailRegistration({ clientId: "12345678-1234-4234-8234-1234567890ab", tenantId: "12345678-1234-4234-8234-1234567890cd" });
  expect(checkMailProviderReadiness({ ...graph, redirectUri: "http://localhost:43123/mail/callback" }).configurationReady).toBe(true);
  expect(() => parseGraphMailRegistration({ clientId: graph.clientId, tenantId: "common" })).toThrow("mail_development_config_unavailable");
});

test("private config loader bounds reads and rejects unsafe files without exposing secret or path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-mail-config-"));
  const path = join(directory, "client.json");
  await chmod(directory, 0o700);
  try {
    await writeFile(path, JSON.stringify({ installed }), { mode: 0o600 });
    expect((await loadGoogleInstalledMailClient(path)).clientId).toBe(installed.client_id);
    const alias = join(directory, "linked.json");
    await symlink(path, alias);
    await expect(loadGoogleInstalledMailClient(alias)).rejects.toThrow("mail_development_config_unavailable");
    await rm(alias);
    await link(path, alias);
    await expect(loadGoogleInstalledMailClient(path)).rejects.toThrow("mail_development_config_unavailable");
    await rm(alias);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(loadGoogleInstalledMailClient(path)).rejects.toThrow("mail_development_config_unavailable");
      await chmod(path, 0o600);
      await chmod(directory, 0o755);
      await expect(loadGoogleInstalledMailClient(path)).rejects.toThrow("mail_development_config_unavailable");
      await chmod(directory, 0o700);
    }
    await writeFile(path, "synthetic_private_client_marker");
    await expect(loadGoogleInstalledMailClient(path)).rejects.toThrow("mail_development_config_unavailable");
    await writeFile(path, Buffer.alloc(65537, 32));
    await expect(loadGoogleInstalledMailClient(path)).rejects.toThrow("mail_development_config_unavailable");
    await expect(loadGoogleInstalledMailClient("relative-client.json")).rejects.toThrow("mail_development_config_unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("actual Node rejects a private FIFO without waiting for a writer", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the private config regression");
  const directory = await mkdtemp(join(tmpdir(), "legalwork-mail-config-fifo-"));
  try {
    await chmod(directory, 0o700);
    const compiled = await Bun.build({ entrypoints: [join(import.meta.dir, "development-config.ts")],
      outdir: directory, target: "node", naming: "config.mjs" });
    expect(compiled.success).toBe(true);
    const fifo = join(directory, "fifo.json");
    expect(spawnSync("mkfifo", ["-m", "600", fifo], { timeout: 2000 }).status).toBe(0);
    const result = spawnSync(node, ["--input-type=module", "--eval",
      'import {loadGoogleInstalledMailClient} from "./config.mjs"; try { await loadGoogleInstalledMailClient(process.argv[1]); process.exitCode=2; } catch(error) { if(error.message!=="mail_development_config_unavailable") process.exitCode=3; }', fifo],
    { cwd: directory, timeout: 2000, encoding: "utf8", env: {} });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
