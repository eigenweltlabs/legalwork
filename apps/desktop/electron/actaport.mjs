import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** @param {string} destination @param {string | Uint8Array} contents */
async function writePrivateFile(destination, contents) {
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

/** Stable paths survive AppImage mounts and versioned Windows application directories. */
export async function prepareActaportRuntime(sourceDirectory, destinationDirectory) {
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  for (const file of ["index.mjs", "auth.mjs"]) {
    const contents = await readFile(path.join(sourceDirectory, file));
    if (contents.length === 0) throw new Error("The Actaport runtime bundle is empty.");
    const destination = path.join(destinationDirectory, file);
    await writePrivateFile(destination, contents);
  }
  return path.join(destinationDirectory, "index.mjs");
}

/**
 * Credentials share the local server's vault; MCP processes receive only short-lived tokens.
 * safeStorage is used only to import the previous desktop-only credential file.
 * @param {{ directory: string, safeStorage: Pick<typeof import('electron').safeStorage, 'isEncryptionAvailable' | 'decryptString' | 'getSelectedStorageBackend'>,
 * loadVault: () => Promise<{ vault: Pick<import('../../server/src/file-storage/oauth/vault.js').OAuthVault, 'path' | 'ready' | 'getEntry' | 'setEntry'>, lock: typeof import('../../server/src/file-storage/oauth/vault.js').vaultLock }>,
 * loadAuth: () => Promise<typeof import('../../../packages/actaport-mcp/src/auth.js')>, fetch?: typeof fetch, platform?: NodeJS.Platform }} options
 */
export function createActaportConnection(options) {
  const legacyPath = path.join(options.directory, "actaport-credentials.enc");
  const credentialKey = JSON.stringify(["actaport", path.resolve(options.directory)]);
  const discoveryPath = path.join(options.directory, "actaport-connection.json");
  const secret = randomBytes(32).toString("hex");
  /** @type {import('node:http').Server | undefined} */
  let server;
  /** @type {Promise<void> | undefined} */
  let starting;
  /** @type {import('../../../packages/actaport-mcp/src/auth.js').TokenProvider | undefined} */
  let tokenProvider;
  let allowWrites = false;
  /** @type {import('../../../packages/actaport-mcp/src/toolsets.js').Toolset[]} */
  let toolsets = [];
  let generation = 0;
  let changes = Promise.resolve();

  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  function mutate(action) {
    const next = changes.then(action);
    changes = next.then(() => undefined, () => undefined);
    return next;
  }

  function legacyEncryptionAvailable() {
    return options.safeStorage.isEncryptionAvailable() && ((options.platform ?? process.platform) !== "linux" || options.safeStorage.getSelectedStorageBackend() !== "basic_text");
  }

  async function stored() {
    const auth = await options.loadAuth();
    const { vault, lock } = await options.loadVault();
    await vault.ready();
    return lock(`${vault.path}:${credentialKey}`, async () => {
      const saved = await vault.getEntry(credentialKey, auth.connectionSchema);
      if (saved !== undefined) {
        // Also finish cleanup after a crash between the vault write and file removal.
        await rm(legacyPath, { force: true });
        return saved;
      }
      let encrypted;
      try { encrypted = await readFile(legacyPath); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      let previous;
      try {
        if (!legacyEncryptionAvailable()) throw new Error("Legacy storage unavailable");
        previous = auth.connectionSchema.parse(JSON.parse(options.safeStorage.decryptString(encrypted)));
      } catch { throw new Error("Could not unlock the previous Actaport credentials. Restore access to the operating system keychain before migrating."); }
      await vault.setEntry(credentialKey, auth.connectionSchema, previous);
      await rm(legacyPath, { force: true });
      return previous;
    });
  }

  async function tokens(force = false) {
    const version = generation;
    if (!tokenProvider) {
      const saved = await stored();
      if (!saved) throw new Error("Connect Actaport in LegalWork to restore access.");
      const auth = await options.loadAuth();
      if (version !== generation) throw new Error("The Actaport connection changed.");
      if (!tokenProvider) {
        allowWrites = saved.allowWrites;
        toolsets = saved.toolsets;
        tokenProvider = auth.createTokenProvider(saved.credentials, { fetch: options.fetch });
      }
    }
    const provider = tokenProvider;
    const token = await provider(force);
    // Disconnect/replace must also invalidate token requests that were already in flight.
    if (version !== generation || provider !== tokenProvider) throw new Error("The Actaport connection changed.");
    return { ...token, allowWrites, toolsets };
  }

  async function persist(credentials, writes, selected) {
    const auth = await options.loadAuth();
    const { vault, lock } = await options.loadVault();
    await vault.ready();
    await lock(`${vault.path}:${credentialKey}`, async () => {
      await vault.setEntry(credentialKey, auth.connectionSchema, { credentials, allowWrites: writes, toolsets: selected });
      await rm(legacyPath, { force: true });
    });
  }

  async function status() {
    const auth = await options.loadAuth();
    const groups = { coreToolCount: auth.coreToolCount, toolsets: auth.toolsetSummaries };
    try {
      const saved = await stored();
      if (saved) return { configured: true, secureStorage: true, allowWrites: saved.allowWrites, enabledToolsets: saved.toolsets, ...groups };
      return { configured: false, secureStorage: true, allowWrites: false, enabledToolsets: [], ...groups };
    } catch { return { configured: false, secureStorage: false, allowWrites: false, enabledToolsets: [], ...groups }; }
  }

  /** @param {import('../../../packages/actaport-mcp/src/auth.js').TokenProvider} [provider] */
  async function test(provider = tokens) {
    const token = await provider(true);
    const auth = await options.loadAuth();
    let response;
    try {
      response = await (options.fetch ?? fetch)(`${auth.ACTAPORT_ORIGIN}/v1/info/me`, {
        redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
      });
    } catch { throw new Error("Could not reach Actaport. Try again shortly."); }
    await response.body?.cancel();
    if (!response.ok) throw new Error("Actaport could not verify this API user. Check API access and credentials.");
    return { ok: true };
  }

  async function connect(input) {
    const auth = await options.loadAuth();
    const parsed = auth.credentialsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Enter all five Actaport API credentials. The Kanzlei-Alias must be a valid realm.");
    const { vault } = await options.loadVault();
    await vault.ready();
    const next = auth.createTokenProvider(parsed.data, { fetch: options.fetch });
    try { await test(next); } catch { throw new Error("Actaport could not verify these credentials. Check the API add-on and API user access."); }
    await persist(parsed.data, false, []);
    generation++;
    tokenProvider = next;
    allowWrites = false;
    toolsets = [];
    return status();
  }

  async function setWriteAccess(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Write access must be enabled or disabled explicitly.");
    const saved = await stored();
    if (!saved) throw new Error("Connect Actaport before changing write access.");
    await persist(saved.credentials, enabled, saved.toolsets);
    generation++;
    allowWrites = enabled;
    return status();
  }

  async function setToolsets(input) {
    const auth = await options.loadAuth();
    const parsed = auth.toolsetsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Select valid Actaport tool groups.");
    const saved = await stored();
    if (!saved) throw new Error("Connect Actaport before changing tool groups.");
    await persist(saved.credentials, saved.allowWrites, parsed.data);
    generation++;
    toolsets = parsed.data;
    return status();
  }

  async function disconnect() {
    generation++;
    tokenProvider = undefined;
    allowWrites = false;
    toolsets = [];
    const auth = await options.loadAuth();
    const { vault, lock } = await options.loadVault();
    await vault.ready();
    await lock(`${vault.path}:${credentialKey}`, async () => {
      // Remove the import source first so disconnect cannot resurrect it on the next read.
      await rm(legacyPath, { force: true });
      await vault.setEntry(credentialKey, auth.connectionSchema);
    });
    return status();
  }

  async function start() {
    if (server) return;
    if (starting) return starting;
    starting = (async () => {
      const instance = createServer(async (request, response) => {
        const reply = (status, value) => {
          response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify(value));
        };
        const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
        const supplied = createHash("sha256").update(String(request.headers.authorization ?? "")).digest();
        if (request.headers.origin || !timingSafeEqual(expected, supplied)) { reply(401, { error: "unauthorized" }); return; }
        if (request.method !== "POST" || request.url !== "/token") { reply(404, { error: "not_found" }); return; }
        try {
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
            if (body.length > 1024) { reply(413, { error: "request_too_large" }); return; }
          }
          const input = JSON.parse(body || "{}");
          if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some((key) => key !== "force") || input.force !== undefined && typeof input.force !== "boolean") {
            reply(400, { error: "invalid_request" }); return;
          }
          reply(200, await tokens(input.force === true));
        } catch { reply(409, { error: "reconnect_required" }); }
      });
      await new Promise((resolve, reject) => { instance.once("error", reject); instance.listen(0, "127.0.0.1", () => resolve(undefined)); });
      const address = instance.address();
      if (!address || typeof address === "string") { instance.close(); throw new Error("Could not start the Actaport connection service."); }
      try {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        await writePrivateFile(discoveryPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/`, token: secret }));
        server = instance;
      } catch (error) { instance.close(); throw error; }
    })();
    try { await starting; } finally { starting = undefined; }
  }

  async function environment() {
    await start();
    const saved = await status();
    return { ACTAPORT_CONNECTION_FILE: discoveryPath, ACTAPORT_ALLOW_WRITES: saved.allowWrites ? "1" : "0",
      ACTAPORT_TOOLSETS: saved.enabledToolsets.join(",") };
  }
  async function close() {
    await starting?.catch(() => undefined);
    const instance = server;
    server = undefined;
    if (instance) await new Promise((resolve) => instance.close(() => resolve(undefined)));
    await rm(discoveryPath, { force: true });
    tokenProvider = undefined;
  }
  return { status, connect: (input) => mutate(() => connect(input)), test: () => test(),
    setWriteAccess: (enabled) => mutate(() => setWriteAccess(enabled)), setToolsets: (input) => mutate(() => setToolsets(input)),
    disconnect: () => mutate(disconnect), environment, close };
}
