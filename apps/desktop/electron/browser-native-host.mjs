import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

/** Native RPC owns commands; this adapter supplies LegalWork's windows, profile, and project authority. */
export function createNativeBrowserHost(options) {
  const entries = new Map();
  const pageOwners = new WeakMap();
  if (typeof options.capture !== "function" || typeof options.capture.close !== "function") throw new Error("The native browser requires a shared screenshot queue.");
  const capturePage = createOwnedBrowserCapture(options.capture, pageOwners, authorize);
  const endpoints = new Map();
  const connections = new Map();
  const extensionChannels = new Map();
  let loading;
  let disposed = false;
  const timer = setInterval(() => {
    for (const entry of entries.values()) {
      if (entry.checking || entry.closed) continue;
      entry.checking = true;
      void authorize(entry.context).catch(() => close(entry)).finally(() => { entry.checking = false; });
    }
  }, 1000);
  timer.unref();

  const key = (owner, context) => `${owner.id}:${context.connectionId || "local"}:${context.workspaceId}:${context.sessionId}`;
  const ownerEntry = binding => [...entries.values()].find(entry => entry.binding === binding && !entry.closed);
  const getPane = () => loading ??= (async () => {
    const [{ createBrowserPane }, electronModule, { Schema }] = await Promise.all([
      import("./browser-native/runtime/pane.mjs"), import("electron"), import("effect"),
    ]);
    const electron = electronModule.default;
    const directory = options.app.getPath("userData");
    const filename = path.join(directory, "native-browser-state.json");
    let saved = {};
    try { const value = JSON.parse(readFileSync(filename, "utf8")); if (value && typeof value === "object" && !Array.isArray(value)) saved = value; }
    catch (error) { if (error.code !== "ENOENT") console.warn("[browser] saved browser state could not be read", error); }
    const flush = () => {
      mkdirSync(directory, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 }); renameSync(temporary, filename);
    };
    const storage = {
      store(name, { schema, initial }) {
        let value = initial;
        if (Object.hasOwn(saved, name)) { try { value = Schema.decodeUnknownSync(schema)(saved[name]); } catch { /* An invalid restore never grants page access. */ } }
        return { get value() { return value; }, set(next) { value = Schema.decodeUnknownSync(schema)(next); saved[name] = Schema.encodeSync(schema)(value); flush(); } };
      },
      remove(name) { delete saved[name]; flush(); },
    };
    const views = new Map();
    return createBrowserPane({
      partition: options.partition,
      // Shared persistent site storage must never receive a per-attachment tunnel proxy.
      network: () => ({ attach: () => () => {}, icon: url => fetchIcon(electron.net, electron.session.fromPartition(options.partition), url) }),
      authorize: async binding => {
        const entry = ownerEntry(binding);
        if (!entry) throw new Error("The browser session no longer has a desktop owner.");
        await authorize(entry.context);
      },
      downloadDirectory: binding => ownerEntry(binding)?.downloadDirectory,
      page: (binding, page) => {
        const entry = ownerEntry(binding);
        if (!entry) throw new Error("The browser page has no owning chat.");
        pageOwners.set(page.contents, entry);
        options.adoptPage(entry.owner, page, entry.context, entry.downloadDirectory);
      },
      capture: capturePage,
      windows: { get: id => [...entries.values()].find(entry => entry.owner.id === id)?.owner },
      serverEndpoints: { get: id => endpoints.get(id) }, storage,
      refs: storage.store("reserved-refs", { schema: Schema.Number, initial: 0 }),
      embeds: { create(view, owner) {
        const id = randomUUID(), listeners = new Set();
        views.set(id, view);
        return { id, show(visible) { view.setVisible(visible && owner.contentView.children.includes(view)); }, on(_event, handler) { listeners.add(handler); return () => listeners.delete(handler); },
          capture: () => capturePage(view.webContents, undefined, () => view.webContents.capturePage()), dispose() { capturePage.close(view.webContents); views.delete(id); listeners.clear(); } };
      } },
      emit(windowID, { binding, event }) {
        const entry = [...entries.values()].find(entry => entry.binding === binding && entry.owner.id === windowID);
        if (!entry || entry.closed) return;
        if (event.type === "focus") options.focusPage(entry.owner, event.tabID, entry.context);
        if (event.type === "state" && event.error) {
          entry.closed = true;
          entry.replaced = event.error === "browser.pane.replaced";
          for (const channel of extensionChannels.values()) if (channel.entry === entry) channel.abort.abort();
          options.sessionError?.(entry.owner, entry.context, event.error);
        }
      },
    });
  })();

  async function attach(owner, context) {
    if (disposed || !owner || owner.isDestroyed()) throw new Error("The browser's app window is unavailable.");
    if (!context?.sessionId || !context.workspaceId) throw new Error("A browser requires its originating project and chat.");
    if (context.connectionId && connections.get(context.connectionId)?.owner !== owner) throw new Error("This server connection belongs to another app window.");
    const entryKey = key(owner, context), previous = entries.get(entryKey);
    if (previous?.replaced && !context.takeControl) throw new Error("This chat's browser is controlled by another app window. Reopen the chat to take control explicitly.");
    if (previous && !previous.closed) { await previous.ready; return previous; }
    if (context.connectionId && !connections.get(context.connectionId)?.local) {
      const connection = connections.get(context.connectionId);
      if (!connection || connection.owner !== owner) throw new Error("This server connection belongs to another app window.");
      const endpoint = gateway(connection, context);
      const session = await authorize(context);
      const downloadDirectory = path.join(options.app.getPath("userData"), "browser-downloads", context.connectionId, context.workspaceId);
      mkdirSync(downloadDirectory, { recursive: true, mode: 0o700 });
      const server = `legalwork-server-${createHash("sha256").update(JSON.stringify([connection.baseUrl, context.workspaceId, context.sessionId])).digest("hex")}`;
      endpoints.set(server, { id: server, url: endpoint, headers: { Authorization: `Bearer ${connection.token}` }, local: false });
      const entry = { owner, context: { ...context, directory: session.location.directory, remote: true }, downloadDirectory, binding: randomUUID(), closed: false, replaced: false, checking: false, ready: Promise.resolve() };
      entries.set(entryKey, entry);
      entry.ready = getPane().then(pane => pane.register(owner.id, entry.binding, { server, session: context.sessionId }));
      try { await entry.ready; return entry; }
      catch (error) { if (!entry.replaced) entries.delete(entryKey); throw error; }
    }
    await authorize(context);
    const engine = await options.resolveEngine();
    if (!engine.running || !engine.baseUrl || !engine.opencodePassword) throw new Error("The local browser engine is unavailable.");
    const { OpenCode } = await import("@opencode/client");
    const headers = { authorization: `Basic ${Buffer.from(`${engine.opencodeUsername || "opencode"}:${engine.opencodePassword}`).toString("base64")}` };
    const client = OpenCode.make({ baseUrl: engine.baseUrl, headers });
    const session = await client.session.get({ sessionID: context.sessionId });
    if (session.agent === "legalwork-scheduled-project") throw new Error("Project-only scheduled runs cannot use a browser.");
    if (session.agent === "document-extractor" || session.metadata?.legalworkReviewWorker === true) throw new Error("An internal review worker cannot own a browser.");
    const directory = await realpath(session.location.directory);
    const verified = { ...context, directory };
    const downloadDirectory = await options.resolveDownloadDirectory(verified, owner.webContents.getURL());
    const relative = path.relative(await realpath(downloadDirectory), directory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("The browser chat does not belong to its project.");
    const server = "legalwork-local-engine";
    endpoints.set(server, { id: server, url: engine.baseUrl, headers, local: true });
    const entry = { owner, context: verified, downloadDirectory, binding: randomUUID(), closed: false, replaced: false, checking: false, ready: Promise.resolve() };
    entries.set(entryKey, entry);
    entry.ready = getPane().then(pane => pane.register(owner.id, entry.binding, { server, session: context.sessionId }));
    try { await entry.ready; return entry; }
    catch (error) { if (!entry.replaced) entries.delete(entryKey); throw error; }
  }
  async function close(entry) {
    for (const channel of extensionChannels.values()) if (channel.entry === entry) channel.abort.abort();
    if (entry.closed) { entries.delete(key(entry.owner, entry.context)); return; }
    entry.closed = true; entries.delete(key(entry.owner, entry.context));
    if (loading) await (await loading).close(entry.owner.id, entry.binding).catch(() => undefined);
  }
  function gateway(connection, context) { return `${connection.baseUrl}/workspace/${encodeURIComponent(context.workspaceId)}/browser/${encodeURIComponent(context.sessionId)}`; }
  async function authorize(context) {
    if (!context?.connectionId || connections.get(context.connectionId)?.local) return options.authorizeBrowserAutomation(context);
    const connection = connections.get(context.connectionId);
    if (!connection || connection.owner.isDestroyed()) throw new Error("The registered LegalWork server is no longer available.");
    const response = await fetch(`${gateway(connection, context)}/api/session/${encodeURIComponent(context.sessionId)}`, {
      headers: { Authorization: `Bearer ${connection.token}` }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`The LegalWork server denied browser access (${response.status}).`);
    const { data } = await response.json();
    if (data?.id !== context.sessionId || !data.location?.directory) throw new Error("The browser chat could not be verified.");
    return data;
  }
  return {
    attach, authorize,
    releaseExtension(owner, context, tabID) {
      const entry = entries.get(key(owner, context));
      const channel = entry && extensionChannels.get(`${entry.binding}:${tabID}`); channel?.abort.abort();
    },
    async registerConnection(owner, value) {
      const url = new URL(value?.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || typeof value.token !== "string" || !value.token.trim()) throw new Error("A valid LegalWork server URL and client token are required.");
      const baseUrl = url.toString().replace(/\/+$/, "");
      for (const [id, connection] of connections) if (connection.owner === owner && connection.baseUrl === baseUrl && connection.token === value.token) return { connectionId: id };
      const local = await options.resolveLegalworkServer?.();
      const connectionId = randomUUID(); connections.set(connectionId, { owner, baseUrl, token: value.token, local: local?.running && local.baseUrl?.replace(/\/+$/, "") === baseUrl });
      return { connectionId };
    },
    async extensionConnection(owner, context, tabID, localURL) {
      const entry = entries.get(key(owner, context));
      if (!entry || entry.closed) throw new Error("The browser is not attached to this chat.");
      if (!entry.context.remote) return localURL;
      const id = `${entry.binding}:${tabID}`, previous = extensionChannels.get(id);
      if (previous && !previous.abort.signal.aborted) return previous.url;
      const connection = connections.get(context.connectionId), prefix = `${gateway(connection, context)}/extensions`;
      const headers = { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" };
      const registration = await fetch(`${prefix}/register`, { method: "POST", headers, body: JSON.stringify({ tabID }), redirect: "error" });
      if (!registration.ok) throw new Error("The LegalWork server could not register browser extensions.");
      const { capability } = await registration.json();
      if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error("The server returned an invalid browser extension identity.");
      const endpoint = `${prefix}/${capability}`, abort = new AbortController(), active = new Map();
      const channel = { entry, abort, url: `${endpoint}/execute` }; extensionChannels.set(id, channel);
      const execute = async command => {
        const operation = new AbortController(); active.set(command.requestID, operation);
        try {
          if (!["batch", "downloads", "upload", "capture", "download"].includes(command.route)) throw new Error("Unsupported browser extension operation.");
          const response = await fetch(`${localURL}/${command.route}`, { method: command.route === "downloads" ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-legalwork-browser-session": context.sessionId },
            ...(command.route === "downloads" ? {} : { body: JSON.stringify(command.body) }), signal: AbortSignal.any([abort.signal, operation.signal]), redirect: "error" });
          let payload = await response.json();
          if (command.route === "downloads" && Array.isArray(payload?.downloads)) payload = { ...payload, downloads: payload.downloads.map(file => ({ ...file, path: null, relativePath: null, transferRequired: file.state === "completed" })) };
          await fetch(`${endpoint}/result`, { method: "POST", headers, body: JSON.stringify({ requestID: command.requestID, status: response.status, payload }), signal: abort.signal, redirect: "error" });
        } catch (error) {
          if (!abort.signal.aborted && !operation.signal.aborted) await fetch(`${endpoint}/result`, { method: "POST", headers, body: JSON.stringify({ requestID: command.requestID, status: 409, payload: { error: "Desktop execution became uncertain; inspect the page before retrying.", detail: error.message } }), signal: abort.signal, redirect: "error" }).catch(() => undefined);
        } finally { active.delete(command.requestID); }
      };
      void (async () => {
        try {
          while (!abort.signal.aborted) {
            const response = await fetch(`${endpoint}/next`, { headers, signal: abort.signal, redirect: "error" });
            if (!response.ok) throw new Error("The browser extension receiver disconnected.");
            const command = await response.json();
            if (typeof command.cancel === "string") active.get(command.cancel)?.abort();
            else if (typeof command.requestID === "string") void execute(command);
            else throw new Error("Invalid browser extension request.");
          }
        } catch { abort.abort(); }
        finally { extensionChannels.delete(id); await fetch(endpoint, { method: "DELETE", headers, redirect: "error" }).catch(() => undefined); }
      })();
      return channel.url;
    },
    async open(owner, url, context) {
      const entry = await attach(owner, context), pane = await getPane();
      const result = await pane.command(owner.id, entry.binding, { type: "tabs.open", url, focus: false });
      return { entry, result };
    },
    async command(owner, context, command) {
      const entry = entries.get(key(owner, context));
      if (!entry || entry.closed) throw new Error("The browser is not attached to this chat.");
      return (await getPane()).command(owner.id, entry.binding, command);
    },
    async destroy(owner) { for (const entry of [...entries.values()]) if (!owner || entry.owner === owner) await close(entry); for (const [id, connection] of connections) if (!owner || connection.owner === owner) connections.delete(id); },
    async dispose() { disposed = true; clearInterval(timer); await Promise.all([...entries.values()].map(close)); connections.clear(); endpoints.clear(); if (loading) await (await loading).dispose(); },
  };
}

/** Recheck the exact owner and queue lifetime after asynchronous permission checks. */
export function createOwnedBrowserCapture(capture, pageOwners, authorize) {
  const run = (contents, signal, operation) => capture(contents, signal, async active => {
    active.throwIfAborted();
    const entry = pageOwners.get(contents);
    if (!entry || entry.closed || entry.owner.isDestroyed()) throw new Error("The browser page no longer has an active chat owner.");
    await authorize(entry.context);
    active.throwIfAborted();
    if (pageOwners.get(contents) !== entry || entry.closed || contents.isDestroyed() || entry.owner.isDestroyed()) throw new Error("The browser page is closed.");
    return operation(active);
  });
  run.close = contents => {
    if (!pageOwners.has(contents)) return;
    capture.close(contents);
    pageOwners.delete(contents);
  };
  return run;
}

function fetchIcon(net, partition, url) {
  return new Promise(resolve => {
    const request = net.request({ url, session: partition, useSessionCookies: true, redirect: "follow" });
    const chunks = []; let bytes = 0;
    const finish = value => { clearTimeout(timeout); resolve(value); };
    const fail = () => { request.abort(); finish(undefined); };
    const timeout = setTimeout(fail, 5000);
    request.on("response", response => {
      const value = response.headers["content-type"], mime = (Array.isArray(value) ? value[0] : value)?.split(";")[0]?.trim().toLowerCase();
      if (response.statusCode !== 200 || !mime?.startsWith("image/")) return fail();
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 256 * 1024) return fail(); chunks.push(chunk); });
      response.on("end", () => finish({ mime, data: Buffer.concat(chunks) })); response.on("error", fail);
    });
    request.on("error", fail); request.end();
  });
}
