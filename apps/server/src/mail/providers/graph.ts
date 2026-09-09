import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { OAuthFetch } from "./oauth.js";
const BASE = "https://graph.microsoft.com/v1.0/me";
const id = z.string().min(1).max(4096).refine(value => value !== "." && value !== ".." && !/[\x00-\x20\x7f]/.test(value));
const text = z.string().max(65536);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const graphFolderSchema = z.object({ id, displayName: text, parentFolderId: id, childFolderCount: count, isHidden: z.boolean().optional() });
export const graphMessageSchema = z.object({ id, parentFolderId: id, conversationId: id.nullable().optional(), subject: text,
    internetMessageId: text.nullable().optional(), receivedDateTime: text, sentDateTime: text.nullable().optional(),
    isRead: z.boolean(), isDraft: z.boolean(), hasAttachments: z.boolean(), importance: z.enum(["low", "normal", "high"]),
    categories: z.array(text).max(1000), lastModifiedDateTime: text, changeKey: id });
export const graphAttachmentSchema = z.object({ id, name: text, contentType: text.nullable().optional(), size: count, isInline: z.boolean(), contentId: text.nullable().optional(),
    "@odata.type": z.enum(["#microsoft.graph.fileAttachment", "#microsoft.graph.itemAttachment", "#microsoft.graph.referenceAttachment"]) });
export type GraphFolder = z.infer<typeof graphFolderSchema>;
export type GraphMessage = z.infer<typeof graphMessageSchema>;
export type GraphAttachment = z.infer<typeof graphAttachmentSchema>;
export class GraphTransportError extends Error {
    constructor(readonly code: "invalid_input" | "invalid_response" | "delta_expired" | "too_large" | "unauthorized" | "inaccessible" | "not_found" | "rate_limited" | "transient" | "cancelled" | "timeout", readonly retryAfterMs = 0) { super(`mail_graph_${code}`); }
    get retryable() { return ["rate_limited", "transient", "timeout"].includes(this.code); }
}
function fail(code: GraphTransportError["code"]): never { throw new GraphTransportError(code); }
/** Every continuation must remain on the exact requested collection; never normalize dot paths into acceptance. */
export function graphContinuation(value: string, path: string): string {
    if (typeof value !== "string" || value.length > 32768 || !value.startsWith("https://graph.microsoft.com/") || /[\x00-\x20\x7f\\]/.test(value))
        return fail("invalid_input");
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        return fail("invalid_input");
    }
    const rawPath = value.slice("https://graph.microsoft.com".length).split(/[?#]/, 1)[0];
    if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || url.pathname !== path || rawPath !== path)
        return fail("invalid_input");
    return value;
}
function retryAfter(value: string | null): number {
    if (!value || value.length > 128)
        return 0;
    if (/^[0-9]+$/.test(value)) {
        const ms = BigInt(value) * 1000n;
        return ms > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(ms);
    }
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))
        return 0;
    const ms = Math.max(0, Date.parse(value) - Date.now());
    return Number.isSafeInteger(ms) ? ms : 0;
}
const segment = (value: string) => encodeURIComponent(id.parse(value));
/** Global-cloud primary mailbox only. Authenticated GETs, no redirects or external attachment URLs. */
export class GraphReadTransport {
    private readonly fetch: OAuthFetch;
    constructor(private readonly options: {
        accessToken: string;
        fetch?: OAuthFetch;
        timeoutMs?: number;
    }) {
        if (typeof options.accessToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(options.accessToken) || !Number.isSafeInteger(options.timeoutMs ?? 30000) || (options.timeoutMs ?? 30000) < 10 || (options.timeoutMs ?? 30000) > 120000)
            fail("invalid_input");
        this.fetch = options.fetch ?? fetch;
    }
    private async *bytes(url: string, maxBytes: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
        const controller = new AbortController();
        let timeout = false;
        const expires = performance.now() + (this.options.timeoutMs ?? 30000);
        const check = () => { if (performance.now() >= expires) {
            timeout = true;
            controller.abort();
            fail("timeout");
        } if (controller.signal.aborted)
            fail("cancelled"); };
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            abort();
        const timer = setTimeout(() => { timeout = true; controller.abort(); }, this.options.timeoutMs ?? 30000);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            check();
            const response = await this.fetch(url, { method: "GET", redirect: "error", signal: controller.signal,
                headers: { Authorization: `Bearer ${this.options.accessToken}`, Prefer: 'IdType="ImmutableId"', Accept: "*/*" } });
            if (performance.now() >= expires || controller.signal.aborted) {
                void response.body?.cancel().catch(() => { });
                check();
            }
            if (response.status !== 200) {
                if (/\/delta(?:\(\))?$/.test(new URL(url).pathname) && [400, 404, 410].includes(response.status)) {
                    let expired = response.status === 410;
                    if (!expired && response.body) {
                        const errorReader = response.body.getReader();
                        let length = 0;
                        const pieces: Uint8Array[] = [];
                        try {
                            while (true) {
                                check();
                                const piece = await errorReader.read();
                                check();
                                if (piece.done)
                                    break;
                                length += piece.value.byteLength;
                                if (length > 8192)
                                    break;
                                pieces.push(piece.value);
                            }
                            if (length <= 8192) {
                                const value: unknown = JSON.parse(Buffer.concat(pieces).toString('utf8'));
                                const parsed = z.object({ error: z.object({ code: z.string().max(128) }) }).safeParse(value);
                                expired = parsed.success && parsed.data.error.code.toLowerCase() === 'syncstatenotfound';
                            }
                        }
                        catch {
                            check();
                        }
                        finally {
                            void errorReader.cancel().catch(() => { });
                        }
                    }
                    if (expired)
                        throw new GraphTransportError('delta_expired');
                }
                void response.body?.cancel().catch(() => { });
                const retry = response.headers.get("retry-after");
                const ms = retryAfter(retry);
                throw new GraphTransportError(response.status === 401 ? "unauthorized" : response.status === 403 || response.status === 405 ? "inaccessible" : response.status === 404 ? "not_found" : response.status === 429 ? "rate_limited" : response.status >= 500 || response.status === 408 ? "transient" : "invalid_response", ms);
            }
            if (!response.body)
                fail("invalid_response");
            reader = response.body.getReader();
            let total = 0;
            while (true) {
                check();
                const next = await reader.read();
                check();
                if (next.done)
                    break;
                total += next.value.byteLength;
                if (total > maxBytes)
                    fail("too_large");
                for (let offset = 0; offset < next.value.byteLength; offset += 65536) {
                    check();
                    yield next.value.subarray(offset, offset + 65536);
                }
            }
            check();
        }
        catch (error) {
            if (timeout)
                fail("timeout");
            if (signal?.aborted)
                fail("cancelled");
            if (error instanceof GraphTransportError)
                throw error;
            fail("transient");
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            controller.abort();
            void reader?.cancel().catch(() => { });
        }
    }
    private async json(url: string, signal?: AbortSignal): Promise<unknown> {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.bytes(url, 4 * 1024 * 1024, signal))
            chunks.push(chunk);
        try {
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        }
        catch {
            return fail("invalid_response");
        }
    }
    private async page<T>(path: string, query: string, schema: z.ZodType<T>, nextLink?: string, signal?: AbortSignal) {
        const url = nextLink === undefined ? `${BASE}${path}?${query}` : graphContinuation(nextLink, `/v1.0/me${path}`);
        const parsed = z.object({ value: z.array(schema).max(500), "@odata.nextLink": z.string().min(1).max(32768).optional() }).safeParse(await this.json(url, signal));
        if (!parsed.success)
            fail("invalid_response");
        const next = parsed.data["@odata.nextLink"];
        if (next !== undefined) {
            graphContinuation(next, `/v1.0/me${path}`);
            if (next === url)
                fail("invalid_response");
        }
        return { items: parsed.data.value, nextLink: next ?? null };
    }
    async getFolder(folderId: string, signal?: AbortSignal) { const parsed = graphFolderSchema.safeParse(await this.json(`${BASE}/mailFolders/${segment(folderId)}?$select=id,displayName,parentFolderId,childFolderCount,isHidden`, signal)); if (!parsed.success || folderId !== 'msgfolderroot' && parsed.data.id !== folderId)
        fail('invalid_response'); return parsed.data; }
    async messageDelta(folderId: string, continuation?: string, signal?: AbortSignal) {
        if(folderId.split(/[\\/]/).some(part=>part==='.'||part==='..'))fail('invalid_input');
        const path = `/v1.0/me/mailFolders/${segment(folderId)}/messages/delta`;
        const validate = (value: string) => {
            // Decode the key once, not the path: Graph emits both OData quoted keys
            // and slash keys, with either literal or percent-encoded base64 padding.
            if (!value.startsWith('https://graph.microsoft.com/'))
                return fail('invalid_response');
            const raw = value.slice('https://graph.microsoft.com'.length).split(/[?#]/, 1)[0]!;
            try {
                graphContinuation(value, raw);
            }
            catch {
                return fail('invalid_response');
            }
            const match = /^\/v1\.0\/me\/(?:mailFolders|mailfolders)(?:\/([^/]+)|\('((?:[^']|'')*)'\))\/messages\/delta$/.exec(raw);
            if (match) {
                try {
                    const key = decodeURIComponent(match[1] ?? match[2] ?? '');
                    if(match[1]===undefined&&!/^(?:[^']|'')*$/.test(key))return fail('invalid_response');
                    const decoded = match[1] === undefined ? key.replaceAll("''", "'") : key;
                    if (decoded === folderId && decoded !== '.' && decoded !== '..')
                        return value;
                }
                catch { }
            }
            return fail('invalid_response');
        };
        const url = continuation === undefined ? `https://graph.microsoft.com${path}?$select=id&$top=100` : validate(continuation);
        const parsed = z.object({ value: z.array(z.object({ id, "@removed": z.object({ reason: z.string().max(128) }).optional() })).max(500), "@odata.nextLink": z.string().min(1).max(32768).optional(), "@odata.deltaLink": z.string().min(1).max(32768).optional() }).safeParse(await this.json(url, signal));
        if (!parsed.success)
            fail('invalid_response');
        const next = parsed.data['@odata.nextLink'], delta = parsed.data['@odata.deltaLink'];
        if ((next === undefined) === (delta === undefined))
            fail('invalid_response');
        if (next !== undefined) {
            validate(next);
            if (next === url)
                fail('invalid_response');
        }
        if (delta !== undefined)
            validate(delta);
        return { items: parsed.data.value, nextLink: next ?? null, deltaLink: delta ?? null };
    }
    listFolders(parentId: string | null, nextLink?: string, signal?: AbortSignal) { return this.page(parentId === null ? "/mailFolders" : `/mailFolders/${segment(parentId)}/childFolders`, "includeHiddenFolders=true&$top=100&$select=id,displayName,parentFolderId,childFolderCount,isHidden", graphFolderSchema, nextLink, signal); }
    listMessages(nextLink?: string, signal?: AbortSignal) { return this.page("/messages", "$top=100&$select=id,parentFolderId,conversationId,subject,internetMessageId,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,importance,categories,lastModifiedDateTime,changeKey", graphMessageSchema, nextLink, signal); }
    async getMessage(messageId: string, signal?: AbortSignal) {
        const value = graphMessageSchema.safeParse(await this.json(`${BASE}/messages/${segment(messageId)}?$select=id,parentFolderId,conversationId,subject,internetMessageId,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,importance,categories,lastModifiedDateTime,changeKey`, signal));
        if (!value.success || value.data.id !== messageId)
            fail("invalid_response");
        return value.data;
    }
    listAttachments(messageId: string, nextLink?: string, signal?: AbortSignal) { return this.page(`/messages/${segment(messageId)}/attachments`, "$top=100&$select=id,name,contentType,size,isInline,contentId", graphAttachmentSchema, nextLink, signal); }
    messageBytes(messageId: string, signal?: AbortSignal) { return this.bytes(`${BASE}/messages/${segment(messageId)}/$value`, 64 * 1024 * 1024, signal); }
    attachmentBytes(messageId: string, attachmentId: string, signal?: AbortSignal) { return this.bytes(`${BASE}/messages/${segment(messageId)}/attachments/${segment(attachmentId)}/$value`, 32 * 1024 * 1024, signal); }
}
