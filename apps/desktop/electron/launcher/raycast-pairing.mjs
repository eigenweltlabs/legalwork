import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PAIRING_FILE = "launcher-pairing.json";

/**
 * Pairing for the optional Raycast adapter. The file holds the local server
 * URL and a client token for the current app session, readable only by this
 * user account. Nothing goes into URLs; Raycast reads the file on each call.
 */
export class RaycastPairing {
  /** @param {{ userDataDir: string, scheme?: string, fetch?: typeof fetch, serverInfo: () => Promise<{ running: boolean, instanceId?: string | null, baseUrl: string | null, hostToken?: string | null }> }} options */
  constructor(options) {
    this.path = path.join(options.userDataDir, PAIRING_FILE);
    this.serverInfo = options.serverInfo;
    this.scheme = options.scheme === "legalwork-dev" ? "legalwork-dev" : "legalwork";
    this.enabled = false;
    this.fetch = options.fetch ?? fetch;
    this.operations = /** @type {Promise<unknown>} */ (Promise.resolve());
  }
  async load() {
    try { const parsed = JSON.parse(await readFile(this.path, "utf8")); this.enabled = parsed?.enabled === true; }
    catch { this.enabled = false; }
    return this.status();
  }
  status() { return { enabled: this.enabled, path: this.enabled ? this.path : null }; }
  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  serial(work) {
    const next = this.operations.catch(() => {}).then(work);
    this.operations = next;
    return next;
  }
  async hostRequest(info, route, method) {
    if (!info?.running || !info.baseUrl || !info.hostToken) throw new Error("Start the local LegalWork server to pair Raycast.");
    const response = await this.fetch(info.baseUrl + route, { method, headers: { "x-legalwork-host-token": info.hostToken }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("The Raycast command expired or the local server is unavailable.");
    return response.json();
  }
  /** @param {string} id @returns {Promise<import("@legalwork/types/launcher").LauncherInvocation | null>} */
  consume(id) { return this.serial(async () => {
    if (!this.enabled) throw new Error("Enable Raycast pairing to run this command.");
    const info = await this.serverInfo();
    const { invocation } = await this.hostRequest(info, "/launcher/raycast/handoff/" + encodeURIComponent(id), "POST");
    return { ...invocation, raycastServerInstanceId: info.instanceId ?? undefined };
  }); }
  /** Rewrite the credential whenever the server (re)starts: tokens are ephemeral per boot. */
  refresh() { return this.serial(() => this.writePairing()); }
  async writePairing(requireServer = false) {
    if (!this.enabled) return this.status();
    const info = await this.serverInfo();
    if (!info.running && !requireServer) return this.status();
    const { token } = await this.hostRequest(info, "/launcher/raycast/pairing", "POST");
    const payload = { enabled: true, version: 2, serverUrl: info.baseUrl, token, scheme: this.scheme, updatedAt: Date.now() };
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      await this.hostRequest(info, "/launcher/raycast/pairing", "DELETE").catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return this.status();
  }
  enable() { return this.serial(async () => {
    const wasEnabled = this.enabled;
    this.enabled = true;
    try { return await this.writePairing(true); } catch (error) { this.enabled = wasEnabled; throw error; }
  }); }
  disable() { return this.serial(async () => {
    const info = await this.serverInfo();
    if (info.running) await this.hostRequest(info, "/launcher/raycast/pairing", "DELETE");
    this.enabled = false;
    await rm(this.path, { force: true });
    return this.status();
  }); }
}
