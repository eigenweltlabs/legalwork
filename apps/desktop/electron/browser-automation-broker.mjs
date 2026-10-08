import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { browserSnapshot, normalizeAccessibilityTree, runBrowserBatch } from "./browser-automation-actions.mjs";

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

async function readBody(request) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64000) throw new Error("Browser batch is too large.");
  }
  return JSON.parse(body);
}

/** A capability URL grants access to one explicitly registered browser tab. */
export function createBrowserAutomationBroker() {
  const grants = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let authority = "";
  let startPromise;
  let closed = false;

  function resolveRequest(request) {
    if ("origin" in request.headers || request.headers.host !== authority) return null;
    const parts = request.url?.split("/") ?? [];
    const grant = grants.get(parts[1]);
    if (!grant || grant.webContents.isDestroyed()) return null;
    return { grant, route: parts.slice(2).join("/") };
  }

  function acquire(grant) {
    if (grant.users === 0) grant.webContents.debugger.attach("1.3");
    grant.users += 1;
  }

  function release(grant) {
    grant.users -= 1;
    if (grant.users === 0) {
      try { grant.webContents.debugger.detach(); } catch { /* Tab may already be closed. */ }
    }
  }

  async function sendCommand(grant, method, params = {}) {
    if (!grants.has(grant.token) || grant.webContents.isDestroyed()) throw new Error("Browser tab is closed.");
    const result = await grant.webContents.debugger.sendCommand(method, params);
    return method === "Accessibility.getFullAXTree" ? normalizeAccessibilityTree(result) : result;
  }

  async function withDebugger(grant, action) {
    acquire(grant);
    try { return await action((method, params) => sendCommand(grant, method, params)); }
    finally { release(grant); }
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    const resolved = resolveRequest(request);
    if (!resolved) { response.writeHead(403).end(); return; }
    const { grant, route } = resolved;
    response.setHeader("Content-Type", "application/json");
    try {
      if (request.method === "GET" && route === "json/list") {
        response.end(JSON.stringify([{
          id: grant.targetId, type: "page", title: grant.webContents.getTitle(), url: grant.webContents.getURL(),
          webSocketDebuggerUrl: `ws://${authority}/${grant.token}/devtools/page/${grant.targetId}`,
        }]));
      } else if (request.method === "GET" && route === "downloads") {
        response.end(JSON.stringify({ downloads: grant.getDownloads() }));
      } else if (request.method === "POST" && route === "batch") {
        if (grant.busy) { response.writeHead(409).end(JSON.stringify({ ok: false, error: "A browser batch is already running on this tab." })); return; }
        grant.busy = true;
        try {
          const body = await readBody(request);
          const result = await withDebugger(grant, (send) => runBrowserBatch(send, grant.webContents, body.steps, body.timeout_ms));
          response.end(JSON.stringify({ ...result, downloads: grant.getDownloads() }));
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
    for (const client of grant.clients) client.terminate();
    grant.webContents.removeListener("destroyed", grant.onDestroyed);
  }

  server.on("upgrade", (request, socket, head) => {
    const resolved = resolveRequest(request);
    if (request.method !== "GET" || !resolved || resolved.route !== `devtools/page/${resolved.grant.targetId}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      const { grant } = resolved;
      const debuggerApi = grant.webContents.debugger;
      try { acquire(grant); }
      catch { client.close(1011, "Browser tab is unavailable for automation"); return; }
      grant.clients.add(client);
      const send = (message) => {
        if (client.readyState === 1) client.send(JSON.stringify(message));
      };
      const onMessage = (_event, method, params, sessionId) => {
        if (!sessionId && EVENT_DOMAINS.has(method.split(".")[0])) send({ method, params });
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
          const result = await sendCommand(grant, message.method, message.params ?? {});
          send({ id: message.id, result });
        } catch (error) {
          send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Browser command failed" } });
        }
      });
      const cleanup = () => {
        if (!grant.clients.delete(client)) return;
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
    async grant(webContents, getDownloads = () => []) {
      await start();
      if (closed || webContents.isDestroyed()) throw new Error("Browser tab is closed");
      const token = randomBytes(32).toString("hex");
      const grant = {
        token, targetId: String(webContents.id), webContents, getDownloads,
        clients: new Set(), users: 0, busy: false, onDestroyed: () => revoke(grant),
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
    async close() {
      closed = true;
      for (const grant of grants.values()) revoke(grant);
      websocketServer.close();
      if (startPromise) {
        await startPromise.catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
