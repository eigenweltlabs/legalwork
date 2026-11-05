// @ts-nocheck
// Generated from ../upstream/diagnostics.ts; OpenCode v2.1.4, MIT. Run scripts/build-browser-controller.mjs.
import { Browser } from "@opencode/plugin-browser/rpc";
const levels = ["debug", "info", "warning", "error"];
// Values the model must not read; the header name still shows it was sent.
const redacted = ["cookie", "set-cookie", "authorization", "proxy-authorization"];
export function createDiagnostics(cdp) {
    const messages = [];
    const requests = new Map();
    // Chromium reuses one request ID across a redirect chain; every hop is retained in order.
    const hops = new Map();
    const latest = (key) => hops.get(key)?.at(-1);
    // Network-stack headers and wire status arrive as ExtraInfo events, in either order relative to
    // the renderer-side events; stash whichever comes first.
    const extra = new Map();
    const scope = crypto.randomUUID();
    let sequence = 0;
    let droppedMessages = 0;
    let droppedRequests = 0;
    const add = (level, text, timestampMs, source) => {
        messages.push({
            id: `${scope}:${++sequence}`,
            timestampMs,
            level,
            text: text.slice(0, 2_000),
            textTruncated: text.length > 2_000,
            ...(source ? { source } : {}),
        });
        if (messages.length > 500) {
            messages.shift();
            droppedMessages++;
        }
    };
    cdp.on("Runtime.consoleAPICalled", (event) => {
        const source = event.stackTrace?.callFrames[0];
        add(event.type === "error" || event.type === "assert"
            ? "error"
            : event.type === "warning"
                ? "warning"
                : event.type === "debug"
                    ? "debug"
                    : "info", event.args
            .map((arg) => typeof arg.value === "string"
            ? arg.value
            : arg.value !== undefined
                ? JSON.stringify(arg.value)
                : (arg.description ?? arg.unserializableValue ?? arg.type))
            .join(" "), event.timestamp, source
            ? { url: source.url.slice(0, Browser.MAX_TEXT), line: source.lineNumber + 1, column: source.columnNumber + 1 }
            : undefined);
    });
    // Chromium's own messages (CSP refusals, mixed content, failed resource loads, deprecations)
    // are Log entries, not Runtime console calls.
    cdp.on("Log.entryAdded", (event) => {
        const entry = event.entry;
        add(entry.level === "verbose" ? "debug" : entry.level, entry.text, entry.timestamp, entry.url
            ? { url: entry.url.slice(0, Browser.MAX_TEXT), line: (entry.lineNumber ?? 0) + 1, column: 1 }
            : undefined);
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
        const error = event.exceptionDetails;
        add("error", error.exception?.description ?? error.text, event.timestamp, error.url ? { url: error.url, line: error.lineNumber + 1, column: error.columnNumber + 1 } : undefined);
    });
    const begin = (key, sessionID, nativeID, started, wallTime, info, request) => {
        const headers = trimHeaders(request.headers);
        const entry = {
            nativeID,
            sessionID,
            started,
            request: { ...request, headers: headers.headers, postData: request.postData?.slice(0, 20_000) },
            headersTruncated: headers.truncated,
            postDataTruncated: (request.postData?.length ?? 0) > 20_000,
            wire: { request: false, response: false },
            info: {
                id: `${scope}:${++sequence}`,
                ...info,
                url: info.url.slice(0, 16_384),
                timestampMs: wallTime * 1000,
                state: "pending",
            },
        };
        requests.set(entry.info.id, entry);
        hops.set(key, [...(hops.get(key) ?? []), entry]);
        // A stash can only belong to this hop: earlier hops would have consumed it on arrival.
        const stashed = extra.get(key);
        if (stashed?.request)
            requestHeaders(entry, stashed.request);
        if (stashed?.response)
            responseInfo(entry, stashed.response);
        extra.delete(key);
        if (requests.size > 500) {
            const first = requests.values().next().value;
            if (first) {
                requests.delete(first.info.id);
                const firstKey = `${first.sessionID ?? ""}:${first.nativeID}`;
                const rest = hops.get(firstKey)?.filter((hop) => hop !== first) ?? [];
                if (rest.length)
                    hops.set(firstKey, rest);
                if (!rest.length)
                    hops.delete(firstKey);
            }
            droppedRequests++;
        }
        return entry;
    };
    const requestHeaders = (request, headers) => {
        const trimmed = trimHeaders({ ...request.request.headers, ...headers });
        request.request = { ...request.request, headers: trimmed.headers };
        request.headersTruncated ||= trimmed.truncated;
        request.wire.request = true;
    };
    const responseInfo = (request, wire) => {
        const trimmed = trimHeaders({ ...request.response?.headers, ...wire.headers });
        request.response = { mimeType: request.response?.mimeType ?? "", headers: trimmed.headers };
        request.headersTruncated ||= trimmed.truncated;
        request.info = { ...request.info, statusCode: wire.statusCode };
        request.wire.response = true;
    };
    const finish = (key, timestamp, failure) => {
        const request = latest(key);
        if (!request)
            return;
        const durationMs = request.started === undefined ? 0 : Math.max(0, (timestamp - request.started) * 1000);
        request.info =
            failure === undefined
                ? { ...request.info, state: "completed", durationMs }
                : { ...request.info, state: "failed", failure: failure.slice(0, 2_048), durationMs };
    };
    cdp.on("Network.requestWillBeSent", (event, sessionID) => {
        const key = `${sessionID ?? ""}:${event.requestId}`;
        const previous = latest(key);
        if (previous && event.redirectResponse) {
            // Wire headers for this hop may already be merged in; the renderer copy lacks set-cookie.
            const response = trimHeaders({ ...event.redirectResponse.headers, ...previous.response?.headers });
            previous.response = { mimeType: event.redirectResponse.mimeType, headers: response.headers };
            previous.headersTruncated ||= response.truncated;
            previous.redirected = true;
            // A cached redirect never gets ExtraInfo; the next hop's must not be attributed to it.
            if (!event.redirectHasExtraInfo)
                previous.wire = { request: true, response: true };
            previous.info = {
                ...previous.info,
                state: "completed",
                statusCode: previous.info.statusCode ?? event.redirectResponse.status,
                durationMs: Math.max(0, (event.timestamp - (previous.started ?? event.timestamp)) * 1000),
            };
        }
        begin(key, sessionID, event.requestId, event.timestamp, event.wallTime, {
            url: event.request.url,
            method: event.request.method,
            resourceType: resourceType((event.type ?? "other").toLowerCase()),
        }, { headers: event.request.headers, hasPostData: event.request.hasPostData, postData: event.request.postData });
    });
    // ExtraInfo for a redirect hop can land after the renderer already started the next hop, so it
    // goes to the earliest hop that has not consumed its own rather than to the latest.
    cdp.on("Network.requestWillBeSentExtraInfo", (event, sessionID) => {
        const key = `${sessionID ?? ""}:${event.requestId}`;
        const request = hops.get(key)?.find((hop) => !hop.wire.request);
        if (request)
            return requestHeaders(request, event.headers);
        extra.set(key, { ...extra.get(key), request: event.headers });
    });
    cdp.on("Network.responseReceived", (event, sessionID) => {
        const request = latest(`${sessionID ?? ""}:${event.requestId}`);
        if (!request)
            return;
        const headers = trimHeaders({ ...event.response.headers, ...request.response?.headers });
        request.response = { mimeType: event.response.mimeType, headers: headers.headers };
        request.headersTruncated ||= headers.truncated;
        // ExtraInfo already carries the wire status when it arrived first; the renderer may report 200 for a 304.
        request.info = { ...request.info, statusCode: request.info.statusCode ?? event.response.status };
        if (!event.hasExtraInfo)
            request.wire = { request: true, response: true };
    });
    cdp.on("Network.responseReceivedExtraInfo", (event, sessionID) => {
        const key = `${sessionID ?? ""}:${event.requestId}`;
        const request = hops.get(key)?.find((hop) => !hop.wire.response);
        if (request)
            return responseInfo(request, event);
        extra.set(key, { ...extra.get(key), response: event });
    });
    // WebSockets never emit requestWillBeSent; their handshake is the whole request lifecycle.
    cdp.on("Network.webSocketCreated", (event, sessionID) => {
        begin(`${sessionID ?? ""}:${event.requestId}`, sessionID, event.requestId, undefined, Date.now() / 1000, { url: event.url, method: "GET", resourceType: "websocket" }, { headers: {}, hasPostData: false });
    });
    cdp.on("Network.webSocketWillSendHandshakeRequest", (event, sessionID) => {
        const request = latest(`${sessionID ?? ""}:${event.requestId}`);
        if (!request)
            return;
        request.started = event.timestamp;
        request.info = { ...request.info, timestampMs: event.wallTime * 1000 };
        requestHeaders(request, event.request.headers);
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", (event, sessionID) => {
        const key = `${sessionID ?? ""}:${event.requestId}`;
        const request = latest(key);
        if (!request)
            return;
        responseInfo(request, { headers: event.response.headers, statusCode: event.response.status });
        finish(key, event.timestamp);
    });
    cdp.on("Network.webSocketFrameError", (event, sessionID) => finish(`${sessionID ?? ""}:${event.requestId}`, event.timestamp, event.errorMessage));
    cdp.on("Network.webSocketClosed", (event, sessionID) => {
        const key = `${sessionID ?? ""}:${event.requestId}`;
        if (latest(key)?.info.state === "pending")
            finish(key, event.timestamp, "Closed before the handshake completed");
    });
    cdp.on("Network.loadingFinished", (event, sessionID) => finish(`${sessionID ?? ""}:${event.requestId}`, event.timestamp));
    cdp.on("Network.loadingFailed", (event, sessionID) => finish(`${sessionID ?? ""}:${event.requestId}`, event.timestamp, event.errorText));
    return {
        clear() {
            messages.length = 0;
            requests.clear();
            hops.clear();
            extra.clear();
            droppedMessages = 0;
            droppedRequests = 0;
        },
        async enable(sessionID) {
            await cdp.send("Runtime.enable", {}, sessionID);
            await cdp.send("Log.enable", {}, sessionID);
            await cdp.send("Network.enable", { maxTotalBufferSize: 5 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024, maxPostDataSize: 20_000 }, sessionID);
        },
        console(input) {
            const matching = messages.filter((entry) => levels.indexOf(entry.level) >= levels.indexOf(input.level ?? "info"));
            const result = bounded(matching, input.limit ?? 100);
            return { messages: result, truncated: matching.length > result.length, dropped: droppedMessages };
        },
        list(input) {
            const matching = Array.from(requests.values())
                .map((request) => request.info)
                .filter((request) => (!input.urlContains || request.url.includes(input.urlContains)) &&
                (!input.resourceType || input.resourceType === request.resourceType));
            const result = bounded(matching, input.limit ?? 100);
            return { requests: result, truncated: matching.length > result.length, dropped: droppedRequests };
        },
        info(id) {
            const request = requests.get(id);
            if (!request)
                throw new Error("Request is no longer retained. Call browser.network.list({tabID}) and use a current request id. Do not reload or resend it just to inspect it.");
            return request.info;
        },
        async get(input) {
            const request = requests.get(input.id);
            if (!request)
                throw new Error("Request ID is no longer retained in this tab or belongs to another tab. Call browser.network.list({tabID}) and copy a current id into browser.network.get with the same tabID. Do not reload or resend a request just to inspect it.");
            const max = input.maxBodyChars ?? 20_000;
            const text = (value) => ({
                state: "text",
                text: value.slice(0, max),
                truncated: value.length > max,
            });
            const responseBody = async () => {
                if (!input.includeBody)
                    return { state: "notRequested" };
                if (request.info.state === "pending")
                    return { state: "pending" };
                if (request.redirected || !request.response || request.info.resourceType === "websocket")
                    return { state: "unavailable", reason: "notCaptured" };
                if (!/^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml|x-www-form-urlencoded))/i.test(request.response.mimeType))
                    return { state: "unavailable", reason: "binary" };
                const body = await cdp
                    .send("Network.getResponseBody", { requestId: request.nativeID }, request.sessionID)
                    .catch(() => undefined);
                if (!body)
                    return { state: "unavailable", reason: "backendUnavailable" };
                const value = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
                return value.length ? text(value) : { state: "empty" };
            };
            const requestBody = !input.includeBody
                ? { state: "notRequested" }
                : request.request.postData !== undefined
                    ? {
                        state: "text",
                        text: request.request.postData.slice(0, max),
                        truncated: request.postDataTruncated || request.request.postData.length > max,
                    }
                    : request.request.hasPostData
                        ? { state: "unavailable", reason: "notCaptured" }
                        : { state: "empty" };
            return {
                request: request.info,
                requestHeaders: headerEntries(request.request.headers),
                responseHeaders: headerEntries(request.response?.headers ?? {}),
                headersTruncated: request.headersTruncated,
                requestBody,
                responseBody: await responseBody(),
            };
        },
    };
}
function resourceType(type) {
    switch (type) {
        case "document":
        case "stylesheet":
        case "image":
        case "media":
        case "font":
        case "script":
        case "xhr":
        case "fetch":
        case "eventsource":
        case "websocket":
        case "manifest":
            return type;
        default:
            return "other";
    }
}
function trimHeaders(headers) {
    const entries = Object.entries(headers);
    const kept = [];
    let size = 0;
    let truncated = entries.length > 100;
    for (const [key, value] of entries.slice(0, 100)) {
        // Lower-case names so renderer and wire copies of one header merge instead of duplicating.
        const name = key.toLowerCase().slice(0, 2_048);
        const text = redacted.includes(name) ? "<redacted>" : String(value);
        const remaining = Math.max(0, 16_000 - size - name.length);
        if (!remaining) {
            truncated = true;
            break;
        }
        const bounded = text.slice(0, Math.min(2_000, remaining));
        truncated ||= bounded.length < text.length || name.length < key.length;
        kept.push([name, bounded]);
        size += name.length + bounded.length;
    }
    return { headers: Object.fromEntries(kept), truncated };
}
function bounded(items, limit) {
    const selected = [];
    let size = 0;
    for (const item of items.slice(-limit).reverse()) {
        size += JSON.stringify(item).length;
        if (size > Browser.MAX_TEXT)
            break;
        selected.push(item);
    }
    return selected.reverse();
}
function headerEntries(headers) {
    return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}
