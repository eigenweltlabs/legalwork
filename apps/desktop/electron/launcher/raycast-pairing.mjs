import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PAIRING_FILE = "launcher-pairing.json";

/**
 * Pairing for the optional Raycast adapter. The file holds the local server
 * URL and a client token for the current app session, readable only by this
 * user account. Nothing goes into URLs; Raycast reads the file on each call.
 */
export class RaycastPairing {
  /** @param {{ userDataDir: string, serverInfo: () => Promise<{ running: boolean, baseUrl: string | null, clientToken: string | null, ownerToken: string | null, hostToken?: string | null }> }} options */
  constructor(options) {
    this.path = path.join(options.userDataDir, PAIRING_FILE);
    this.serverInfo = options.serverInfo;
    this.enabled = false;
  }
  async load() {
    try { const parsed = JSON.parse(await readFile(this.path, "utf8")); this.enabled = parsed?.enabled === true; }
    catch { this.enabled = false; }
    return this.status();
  }
  status() { return { enabled: this.enabled, path: this.enabled ? this.path : null }; }
  /** Rewrite the credential whenever the server (re)starts: tokens are ephemeral per boot. */
  async refresh() {
    if (!this.enabled) return this.status();
    const info = await this.serverInfo().catch(() => null);
    // Only the collaborator-scoped client token leaves the app; the owner token never reaches another process.
    if (!info?.running || !info.baseUrl || !info.clientToken) return this.status();
    const payload = { enabled: true, version: 1, serverUrl: info.baseUrl, token: info.clientToken, scheme: "legalwork", updatedAt: Date.now() };
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, this.path);
    return this.status();
  }
  async enable() { this.enabled = true; return this.refresh(); }
  async disable() {
    this.enabled = false;
    await rm(this.path, { force: true });
    return this.status();
  }
}
