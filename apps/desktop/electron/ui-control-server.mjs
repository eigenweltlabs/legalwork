// Local UI-control HTTP bridge: a loopback server exposing /snapshot,
// /actions, /execute, dispatched to the renderer's window.__legalworkControl
// surface via executeJavaScript. Consumed over HTTP by legalwork-ui-mcp.
// Extracted from main.mjs; state and lifecycle live in this factory
// (createRuntimeManager pattern).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export function createUiControlServer({ appName, appIdentifier, getWindow, getUserDataDir }) {
  let uiControlServer = null;
  let uiControlDiscoveryPath = null;
  const uiControlToken = randomBytes(32).toString("hex");
  const operations = new Map();

  function cancelOperation(requestId, reason = new DOMException("Document operation cancelled.", "AbortError")) {
    const operation = operations.get(requestId);
    if (!operation || operation.controller.signal.aborted) return;
    operation.controller.abort(reason);
    // Cancellation acknowledgement must not wait on an unresponsive renderer.
    void evaluateLegalworkControl(`window.__legalworkControl?.cancel(${JSON.stringify(requestId)})`).catch(() => {});
  }

  function sendJsonResponse(response, statusCode, payload) {
    if (response.destroyed) return;
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }

  function readJsonRequestBody(request) {
    return new Promise((resolve, reject) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 5 * 1024 * 1024) {
          reject(new Error("Request body too large"));
          request.destroy();
        }
      });
      request.on("end", () => {
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Request body must be JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  // Hashed before comparing so the check takes the same time whatever the
  // caller sends, and so mismatched lengths do not throw.
  function authorizedUiControlRequest(request) {
    const auth = String(request.headers.authorization ?? "");
    if (!auth) return false;
    return timingSafeEqual(
      createHash("sha256").update(auth).digest(),
      createHash("sha256").update(`Bearer ${uiControlToken}`).digest(),
    );
  }

  function jsonForJavaScript(value) {
    return JSON.stringify(JSON.stringify(value ?? {}));
  }

  async function evaluateLegalworkControl(expression, options = {}) {
    const win = await getWindow();
    if (options.focus === true) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return win.webContents.executeJavaScript(expression, options.focus === true);
  }

  async function runLegalworkControlCommand(command, args = {}) {
    const argsJsonLiteral = jsonForJavaScript(args);
    if (command === "snapshot") {
      return evaluateLegalworkControl(`(async () => {
        const control = window.__legalworkControl;
        if (!control) return { ok: false, error: "LegalWork control surface is not available yet." };
        return { ok: true, ...control.snapshot() };
      })()`);
    }
    if (command === "actions") {
      return evaluateLegalworkControl(`(async () => {
        const control = window.__legalworkControl;
        if (!control) return { ok: false, error: "LegalWork control surface is not available yet." };
        return { ok: true, actions: control.listActions() };
      })()`);
    }
    if (command === "execute") {
      const requestId = typeof args.requestId === "string" ? args.requestId : randomUUID();
      if (operations.has(requestId)) throw new Error("This document operation is already running.");
      const deadline = Math.min(Date.now() + 900_000, Number.isFinite(args.deadline) ? args.deadline : Date.now() + 120_000);
      if (deadline <= Date.now()) throw new DOMException("Document request expired.", "TimeoutError");
      const controller = new AbortController();
      operations.set(requestId, { controller, sessionId: args.args?.sessionId ?? args.callerSessionId });
      const timer = setTimeout(() => cancelOperation(requestId, new DOMException("Document request timed out.", "TimeoutError")), deadline - Date.now());
      let abort;
      const cancelled = new Promise((_, reject) => { abort = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", abort, { once: true }); });
      const execution = JSON.stringify({ requestId, deadline });
      // Agent edits run in the background. Raising the app requires an explicit request.
      try { return await Promise.race([cancelled, evaluateLegalworkControl(`(async () => {
        const control = window.__legalworkControl;
        const input = JSON.parse(${argsJsonLiteral});
        if (!control) return { ok: false, error: "LegalWork control surface is not available yet." };
        if (!input || typeof input.actionId !== "string" || !input.actionId.trim()) {
          return { ok: false, error: "Missing LegalWork actionId." };
        }
        return control.execute(input.actionId, input.args ?? {}, typeof input.callerSessionId === "string" ? input.callerSessionId : undefined, ${execution});
      })()`, { focus: args.focus === true })]); }
      finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); operations.delete(requestId); }
    }
    return { ok: false, error: `Unknown LegalWork control command: ${command}` };
  }

  async function start() {
    if (uiControlServer) return;
    uiControlServer = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/health") {
          sendJsonResponse(response, 200, { ok: true, app: appName, version: 1 });
          return;
        }
        if (!authorizedUiControlRequest(request)) {
          sendJsonResponse(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (request.method === "POST" && url.pathname === "/cancel") {
          const body = await readJsonRequestBody(request);
          for (const [id, operation] of operations) if (id === body.requestId || typeof body.sessionId === "string" && operation.sessionId === body.sessionId) cancelOperation(id);
          sendJsonResponse(response, 200, { ok: true });
          return;
        }
        if (request.method === "GET" && url.pathname === "/snapshot") {
          sendJsonResponse(response, 200, await runLegalworkControlCommand("snapshot"));
          return;
        }
        if (request.method === "GET" && url.pathname === "/actions") {
          sendJsonResponse(response, 200, await runLegalworkControlCommand("actions"));
          return;
        }
        if (request.method === "POST" && url.pathname === "/execute") {
          const body = await readJsonRequestBody(request);
          body.requestId ??= randomUUID();
          response.once("close", () => { if (!response.writableFinished) cancelOperation(body.requestId); });
          sendJsonResponse(response, 200, await runLegalworkControlCommand("execute", body));
          return;
        }
        sendJsonResponse(response, 404, { ok: false, error: "Not found" });
      } catch (error) {
        const code = error?.name === "TimeoutError" ? "operation_timeout" : error?.name === "AbortError" ? "operation_cancelled" : undefined;
        sendJsonResponse(response, code === "operation_timeout" ? 408 : code === "operation_cancelled" ? 409 : 500, { ok: false, ...(code ? { code } : {}), error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise((resolve, reject) => {
      uiControlServer.once("error", reject);
      uiControlServer.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = uiControlServer.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Could not start LegalWork UI control bridge.");
    const discoveryPath = path.join(getUserDataDir(), "legalwork-ui-control.json");
    const temporaryPath = `${discoveryPath}.${randomBytes(16).toString("hex")}.tmp`;
    // Never put a fresh token in an existing inode: older releases created this
    // file with wider permissions. Publish a new owner-only file atomically.
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, app: appName, identifier: appIdentifier, platform: process.platform, baseUrl: `http://127.0.0.1:${port}`, token: uiControlToken }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      // Windows readers and antivirus scans can briefly prevent replacement.
      // Retry the atomic rename, never write a new token into the old inode.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporaryPath, discoveryPath);
          break;
        } catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 5) throw error;
          await sleep(50 * (attempt + 1));
        }
      }
      uiControlDiscoveryPath = discoveryPath;
    } catch (error) {
      await new Promise((resolve) => uiControlServer.close(() => resolve(undefined)));
      uiControlServer = null;
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
    // Make the discovery path available to child processes (server → managed OpenCode → plugin).
    process.env.LEGALWORK_UI_CONTROL_DISCOVERY = uiControlDiscoveryPath;
  }

  async function stop() {
    if (uiControlDiscoveryPath) {
      await rm(uiControlDiscoveryPath, { force: true }).catch(() => undefined);
      uiControlDiscoveryPath = null;
    }
    if (!uiControlServer) return;
    const server = uiControlServer;
    uiControlServer = null;
    for (const id of operations.keys()) cancelOperation(id);
    const closing = new Promise((resolve) => server.close(() => resolve(undefined)));
    // Stop owns these loopback connections. They must not keep app quit alive.
    server.closeAllConnections();
    await closing;
  }

  return { start, stop };
}
