import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { browserSnapshot, normalizeAccessibilityTree, runBrowserBatch } from "./browser-automation-actions.mjs";
import { browserAbortable, createBrowserCaptureQueue } from "./browser-capture-queue.mjs";

// The browser tools only need page operations. Never forward Browser/Target
// commands or client-supplied session IDs, which can reach other renderers.
const ALLOWED_METHODS = new Set([
  "Accessibility.enable", "Accessibility.getFullAXTree",
  "DOM.getBoxModel", "DOM.resolveNode",
  "Input.dispatchKeyEvent", "Input.dispatchMouseEvent",
  "Page.captureScreenshot", "Page.enable", "Page.navigate",
  "Runtime.callFunctionOn", "Runtime.evaluate",
]);
const EVENT_DOMAINS = new Set(["Accessibility", "DOM", "Input", "Page", "Runtime"]);

async function readBody(request, maximum = 64000) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maximum) throw new Error("Browser batch is too large.");
  }
  return JSON.parse(body);
}

/** A capability URL grants access to one explicitly registered browser tab. */
export function createBrowserAutomationBroker({ authorize, capture = createBrowserCaptureQueue() }) {
  if (typeof authorize !== "function") throw new Error("Browser automation requires a network policy check.");
  const grants = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let authority = "";
  let startPromise;
  let closed = false;

  async function authorizeGrant(grant) {
    if (!grants.has(grant.token) || grant.webContents.isDestroyed()) throw new Error("Browser tab is closed.");
    try { await authorize(grant.context); }
    catch (error) {
      revoke(grant);
      // Stop the page too, so its scripts cannot keep using a revoked grant.
      try { grant.webContents.close(); } catch { /* Already closed. */ }
      throw error;
    }
    if (!grants.has(grant.token) || grant.webContents.isDestroyed()) throw new Error("Browser tab is closed.");
  }

  // A page can keep making requests without another tool call. Revoke its
  // capability and close it when the originating chat's policy changes.
  const policyTimer = setInterval(() => {
    for (const grant of grants.values()) {
      if (grant.checking) continue;
      grant.checking = true;
      void authorizeGrant(grant).catch(() => {}).finally(() => { grant.checking = false; });
    }
  }, 1000);
  policyTimer.unref();

  function resolveRequest(request) {
    if ("origin" in request.headers || request.headers.host !== authority) return null;
    const parts = request.url?.split("/") ?? [];
    const grant = grants.get(parts[1]);
    if (!grant || grant.webContents.isDestroyed()) return null;
    return { grant, route: parts.slice(2).join("/") };
  }

  function acquire(grant) {
    if (grant.users === 0) {
      grant.ownsDebugger = !grant.webContents.debugger.isAttached?.();
      if (grant.ownsDebugger) grant.webContents.debugger.attach("1.3");
    }
    grant.users += 1;
  }

  function release(grant) {
    grant.users -= 1;
    if (grant.users === 0 && grant.ownsDebugger) {
      grant.ownsDebugger = false;
      try { grant.webContents.debugger.detach(); } catch { /* Tab may already be closed. */ }
    }
  }

  async function sendCommand(grant, method, params = {}, signal, activity = true) {
    await browserAbortable(() => authorizeGrant(grant), signal);
    signal?.throwIfAborted();
    if (activity) grant.onActivity?.();
    const operation = () => grant.webContents.debugger.sendCommand(method, params);
    // Cancelling a caller does not cancel Chromium's screenshot or its temporary
    // viewport. Keep the page lease until that native operation actually settles.
    const result = method === "Page.captureScreenshot" ? await operation() : await browserAbortable(operation, signal);
    return method === "Accessibility.getFullAXTree" ? normalizeAccessibilityTree(result) : result;
  }

  async function withDebugger(grant, action, signal, activity = true) {
    await browserAbortable(() => authorizeGrant(grant), signal);
    signal?.throwIfAborted();
    acquire(grant);
    try { return await action(async (method, params) => {
      signal?.throwIfAborted();
      const value = await sendCommand(grant, method, params, signal, activity);
      signal?.throwIfAborted(); return value;
    }); }
    finally { release(grant); }
  }

  function withCapture(grant, action, signal, activity = true, prepare = grant.prepareCapture) {
    const stopping = signal ? AbortSignal.any([signal, grant.abort.signal]) : grant.abort.signal;
    return capture(grant.webContents, stopping, active => withDebugger(grant, async send => {
      active.throwIfAborted();
      const cleanup = prepare?.();
      const restoreOnStop = () => cleanup?.();
      active.addEventListener("abort", restoreOnStop, { once: true });
      try {
        active.throwIfAborted();
        return await action(send);
      } finally {
        active.removeEventListener("abort", restoreOnStop);
        cleanup?.();
      }
    }, active, activity));
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    const resolved = resolveRequest(request);
    if (!resolved) { response.writeHead(403).end(); return; }
    const { grant, route } = resolved;
    const callingSession = request.headers["x-legalwork-browser-session"];
    if ((callingSession !== undefined && callingSession !== grant.context?.sessionId) || (["capture", "upload", "download", "passwords", "fill-password"].includes(route) && callingSession !== grant.context?.sessionId)) {
      response.writeHead(403).end(); return;
    }
    const abort = new AbortController();
    response.once("close", () => { if (!response.writableEnded) abort.abort(new Error("Browser request was cancelled; inspect the page before retrying.")); });
    response.setHeader("Content-Type", "application/json");
    try { await authorizeGrant(grant); }
    catch (error) { response.writeHead(403).end(JSON.stringify({ ok: false, error: error.message })); return; }
    try {
      if (request.method === "GET" && route === "passwords") {
        if (!grant.passwords) throw new Error("Browser passwords require the local desktop browser.");
        response.end(JSON.stringify(await grant.passwords.list(AbortSignal.any([abort.signal, grant.abort.signal]))));
      } else if (request.method === "POST" && route === "fill-password") {
        if (!grant.passwords) throw new Error("Browser passwords require the local desktop browser.");
        if (grant.busy) throw new Error("A browser mutation is already running in this tab.");
        grant.busy = true;
        try {
          const body = await readBody(request);
          response.end(JSON.stringify(await grant.passwords.fill(body, AbortSignal.any([abort.signal, grant.abort.signal]))));
        } finally { grant.busy = false; }
      } else if (request.method === "GET" && route === "json/list") {
        response.end(JSON.stringify([{
          id: grant.targetId, type: "page", title: grant.webContents.getTitle(), url: grant.webContents.getURL(),
          webSocketDebuggerUrl: `ws://${authority}/${grant.token}/devtools/page/${grant.targetId}`,
        }]));
      } else if (request.method === "POST" && route === "download") {
        const body = await readBody(request);
        const file = grant.getDownloads().find(item => item.id === body.id && item.state === "completed");
        if (!file?.path) throw new Error("Only a completed download owned by this browser tab can be transferred.");
        const bytes = await readFile(file.path, { signal: abort.signal });
        response.end(JSON.stringify({ id: file.id, name: file.name, data: bytes.toString("base64") }));
      } else if (request.method === "GET" && route === "downloads") {
        response.end(JSON.stringify({ downloads: grant.getDownloads() }));
      } else if (request.method === "POST" && route === "batch") {
        if (grant.busy) { response.writeHead(409).end(JSON.stringify({ ok: false, error: "A browser batch is already running on this tab." })); return; }
        grant.busy = true;
        try {
          const body = await readBody(request);
          const result = await withDebugger(grant, (send) => runBrowserBatch(send, grant.webContents, body.steps, body.timeout_ms), abort.signal);
          response.end(JSON.stringify({ ...result, downloads: grant.getDownloads() }));
        } finally { grant.busy = false; }
      } else if (request.method === "POST" && route === "capture") {
        const body = await readBody(request);
        if (!body || !["png", "jpeg", "webp"].includes(body.format ?? "png") || body.quality !== undefined && (!Number.isInteger(body.quality) || body.quality < 1 || body.quality > 100)) throw new Error("Invalid screenshot format or quality.");
          const result = await withCapture(grant, async send => {
            const layout = await send("Page.getLayoutMetrics", {});
            const bounds = layout.cssContentSize || layout.contentSize;
            const format = body.format ?? "png";
            const image = await send("Page.captureScreenshot", { format, quality: format === "png" ? undefined : body.quality ?? 80, captureBeyondViewport: body.fullPage !== false,
              ...(body.fullPage === false ? {} : { clip: { x: 0, y: 0, width: bounds.width, height: bounds.height, scale: 1 } }) });
            return { mime: `image/${format}`, data: image.data };
          }, abort.signal);
          response.end(JSON.stringify(result));
      } else if (request.method === "POST" && route === "upload") {
        if (grant.busy) { response.writeHead(409).end(JSON.stringify({ error: "A browser mutation is already running in this tab." })); return; }
        grant.busy = true;
        try {
          const body = await readBody(request, Infinity);
          if (typeof body?.selector !== "string" || !body.selector || body.selector.length > 2000 || !Array.isArray(body.files) || !body.files.length) throw new Error("Use an observed file input selector and file bytes.");
          const directory = await mkdtemp(path.join(tmpdir(), "legalwork-browser-upload-")); grant.uploads.add(directory);
          const files = [];
          for (const [index, file] of body.files.entries()) {
            abort.signal.throwIfAborted();
            if (typeof file?.name !== "string" || typeof file.data !== "string") throw new Error("Invalid upload bytes.");
            const bytes = Buffer.from(file.data, "base64");
            if (bytes.toString("base64") !== file.data) throw new Error("Invalid upload bytes.");
            const name = path.basename(file.name.replaceAll("\\", "/"));
            if (!name || name === "." || name === "..") throw new Error("Invalid upload filename.");
            const folder = path.join(directory, String(index)); await mkdir(folder, { mode: 0o700 });
            const destination = path.join(folder, name); await writeFile(destination, bytes, { mode: 0o600 }); files.push(destination);
          }
          await withDebugger(grant, async send => {
            const document = await send("DOM.getDocument", {});
            const nodes = await send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector: body.selector });
            if (nodes.nodeIds.length !== 1) throw new Error("Upload selector must identify exactly one file input.");
            await send("DOM.setFileInputFiles", { nodeId: nodes.nodeIds[0], files });
          }, abort.signal);
          response.end(JSON.stringify({ uploaded: body.files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.data, "base64") })) }));
        } finally { grant.busy = false; }
      } else {
        response.writeHead(403).end();
      }
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Browser request failed." }));
    }
  });

  function revoke(grant) {
    grants.delete(grant.token);
    grant.abort.abort(new Error("Browser tab capability was revoked."));
    for (const directory of grant.uploads) void rm(directory, { recursive: true, force: true });
    for (const client of grant.clients) client.terminate();
    grant.webContents.removeListener("destroyed", grant.onDestroyed);
  }

  server.on("upgrade", async (request, socket, head) => {
    const resolved = resolveRequest(request);
    if (request.method !== "GET" || !resolved || resolved.route !== `devtools/page/${resolved.grant.targetId}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try { await authorizeGrant(resolved.grant); }
    catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    if (socket.destroyed) return;
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      const { grant } = resolved;
      const disconnected = new AbortController();
      const debuggerApi = grant.webContents.debugger;
      try { acquire(grant); }
      catch { client.close(1011, "Browser tab is unavailable for automation"); return; }
      grant.clients.add(client);
      const send = (message) => {
        if (client.readyState === 1) client.send(JSON.stringify(message));
      };
      const onMessage = async (_event, method, params, sessionId) => {
        if (sessionId || !EVENT_DOMAINS.has(method.split(".")[0])) return;
        try { await authorizeGrant(grant); send({ method, params }); } catch { /* Policy revocation closes the connection. */ }
      };
      const onDetach = () => client.close(1011, "Browser debugger detached");
      debuggerApi.on("message", onMessage);
      debuggerApi.on("detach", onDetach);
      client.on("message", async (data) => {
        if (!grants.has(grant.token) || grant.webContents.isDestroyed()) return;
        let message;
        try { message = JSON.parse(data.toString()); }
        catch { client.close(1007, "Invalid CDP message"); return; }
        if (!Number.isSafeInteger(message?.id)) { client.close(1007, "Invalid CDP message ID"); return; }
        if (!ALLOWED_METHODS.has(message.method) || message.sessionId !== undefined) {
          send({ id: message.id, error: { code: -32601, message: "Command is not available for browser automation" } });
          return;
        }
        try {
          const result = message.method === "Page.captureScreenshot"
            ? await withCapture(grant, send => send(message.method, message.params ?? {}), disconnected.signal)
            : await sendCommand(grant, message.method, message.params ?? {});
          send({ id: message.id, result });
        } catch (error) {
          send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Browser command failed" } });
        }
      });
      const cleanup = () => {
        if (!grant.clients.delete(client)) return;
        disconnected.abort(new Error("Browser page connection was closed."));
        debuggerApi.removeListener("message", onMessage);
        debuggerApi.removeListener("detach", onDetach);
        release(grant);
      };
      client.once("close", cleanup);
      client.on("error", () => { cleanup(); client.terminate(); });
    });
  });

  function start() {
    if (closed) return Promise.reject(new Error("Browser automation broker is closed"));
    startPromise ??= new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("Browser automation listener is unavailable")); return; }
        authority = `127.0.0.1:${address.port}`;
        server.unref();
        resolve();
      });
    });
    return startPromise;
  }

  return {
    async grant(webContents, getDownloads = () => [], context, onActivity, prepareCapture, passwords) {
      await authorize(context);
      await start();
      if (closed || webContents.isDestroyed()) throw new Error("Browser tab is closed");
      const token = randomBytes(32).toString("hex");
      const grant = {
        token, targetId: String(webContents.id), webContents, getDownloads, context, onActivity, prepareCapture, passwords, uploads: new Set(),
        clients: new Set(), users: 0, busy: false, checking: false, abort: new AbortController(), onDestroyed: () => revoke(grant),
      };
      grants.set(token, grant);
      webContents.once("destroyed", grant.onDestroyed);
      return { browser_url: `http://${authority}/${token}`, target_id: grant.targetId };
    },
    async snapshot(webContents) {
      const grant = [...grants.values()].find((entry) => entry.webContents === webContents);
      if (!grant) throw new Error("Browser tab has no automation grant.");
      return withDebugger(grant, (send) => browserSnapshot(send, webContents));
    },
    async preview(webContents, prepare) {
      const grant = [...grants.values()].find(entry => entry.webContents === webContents);
      if (!grant) return null;
      return withCapture(grant, async send => {
        // Previewing from the app is not agent activity and must not reclaim a
        // dismissed tab or detach a debugger another tool is still using.
        const image = await send("Page.captureScreenshot", {
          format: "png", captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1200, height: 800, scale: 0.4 },
        });
        return image.data ? `data:image/png;base64,${image.data}` : null;
      }, undefined, false, prepare);
    },
    async close() {
      closed = true;
      clearInterval(policyTimer);
      for (const grant of grants.values()) revoke(grant);
      websocketServer.close();
      if (startPromise) {
        await startPromise.catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
