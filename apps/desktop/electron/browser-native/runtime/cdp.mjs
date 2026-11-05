// @ts-nocheck
// Generated from ../upstream/cdp.ts; OpenCode v2.1.4, MIT. Run scripts/build-browser-controller.mjs.
import { protocolError } from "./errors.mjs";
export function createCdp(contents) {
    const listeners = new Map();
    const sessions = new Set([""]);
    const receive = (_event, name, params, sessionID) => {
        if (!sessions.has(sessionID ?? ""))
            return;
        if (name === "Target.attachedToTarget") {
            const event = params;
            if (event.targetInfo.type === "iframe")
                sessions.add(event.sessionId);
        }
        if (name === "Target.detachedFromTarget")
            sessions.delete(params.sessionId);
        listeners.get(name)?.forEach((callback) => callback(params, sessionID || undefined));
    };
    contents.debugger.on("message", receive);
    return {
        async send(method, params = {}, sessionID) {
            if (contents.isDestroyed())
                throw new Error("Browser tab was closed. Call browser.tabs.list({}) and choose an existing tabID, or browser.tabs.open({}) if no tabs remain.");
            // attach can throw synchronously; sendCommand can reject asynchronously.
            try {
                if (!contents.debugger.isAttached())
                    contents.debugger.attach("1.3");
                return await contents.debugger.sendCommand(method, params, sessionID);
            }
            catch (error) {
                throw protocolError(method, error);
            }
        },
        on(method, callback) {
            const handler = (params, sessionID) => callback(params, sessionID);
            const handlers = listeners.get(method) ?? new Set();
            handlers.add(handler);
            listeners.set(method, handlers);
            return () => {
                handlers.delete(handler);
                if (!handlers.size)
                    listeners.delete(method);
            };
        },
        dispose() {
            contents.debugger.off("message", receive);
            listeners.clear();
        },
    };
}
export function abortError(signal) {
    if (signal.aborted)
        throw new Error("Browser operation was cancelled. Inspect the tab before deciding to repeat an action; cancellation does not undo changes already made.");
}
export async function waitFor(check, signal, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    const timeout = () => new Error(`Condition was not met within ${timeoutMs} ms.`);
    // A busy renderer can hold one check past the deadline, so each check races the remaining time.
    while (true) {
        abortError(signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw timeout();
        let timer;
        const expired = new Promise((_, reject) => {
            timer = setTimeout(() => reject(timeout()), remaining);
        });
        if (await Promise.race([check(), expired]).finally(() => clearTimeout(timer)))
            return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
