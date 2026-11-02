import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { Splitter, MimeNode, type SplitterChunk } from "@zone-eu/mailsplit";
import iconv from "iconv-lite";
import libmime from "libmime";

export type MimeErrorCode = "invalid_input" | "limit" | "timeout" | "cancelled" | "malformed" | "unsupported" | "source_failed" | "sink_failed" | "hash_mismatch";
const errorCodes = new Set<MimeErrorCode>(["invalid_input", "limit", "timeout", "cancelled", "malformed", "unsupported", "source_failed", "sink_failed", "hash_mismatch"]);
export class MimeProjectionError extends Error {
  constructor(readonly code: MimeErrorCode) { super(`mail_mime_${code}`); }
}
export interface MimeLimits {
  maxInputBytes: number; maxHeaderBytes: number; maxBodyBytes: number; maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number; maxParts: number; maxAttachments: number; maxDepth: number; timeoutMs: number;
}
export interface MimeAttachmentMetadata {
  partId: string; filename: string | null; contentType: string; disposition: "inline" | "attachment"; contentId: string | null;
}
export interface MimeProjection {
  version: 1; originalSha256: string; validation: "supported-projection";
  metadata: { subject: string | null; from: string | null; to: string | null; cc: string | null; bcc: string | null;
    replyTo: string | null; date: string | null; messageId: string | null };
  bodies: { partId: string; contentType: "text/plain" | "text/html"; text: string; presentation?: boolean }[];
  attachments: (MimeAttachmentMetadata & { bytes: number; sha256: string })[];
}
export interface MimeProjectionInput {
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>; originalSha256: string; limits?: Partial<MimeLimits>; signal?: AbortSignal;
  onAttachment(part: MimeAttachmentMetadata, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void>;
}
const defaults: MimeLimits = { maxInputBytes: 64 * 1024 * 1024, maxHeaderBytes: 256 * 1024, maxBodyBytes: 2 * 1024 * 1024,
  maxAttachmentBytes: 32 * 1024 * 1024, maxTotalAttachmentBytes: 64 * 1024 * 1024, maxParts: 1000, maxAttachments: 100, maxDepth: 16, timeoutMs: 30000 };
const maxima: MimeLimits = { maxInputBytes: 1024 * 1024 * 1024, maxHeaderBytes: 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024,
  maxAttachmentBytes: 512 * 1024 * 1024, maxTotalAttachmentBytes: 1024 * 1024 * 1024, maxParts: 2000, maxAttachments: 500, maxDepth: 32, timeoutMs: 120000 };
function limits(input: Partial<MimeLimits> = {}): MimeLimits {
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new MimeProjectionError("invalid_input");
  const selected = { ...defaults, ...input };
  for (const key of Object.keys(defaults)) {
    const value: unknown = Reflect.get(selected, key), max: unknown = Reflect.get(maxima, key);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || typeof max !== "number" || value > max) throw new MimeProjectionError("invalid_input");
  }
  return selected;
}
function clean(value: string | false | undefined): string | null {
  if (!value) return null;
  if (Buffer.byteLength(value) > 16384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new MimeProjectionError("malformed");
  return value.replace(/[\r\n\t ]+/g, " ").trim() || null;
}
function chunk(value: unknown): SplitterChunk {
  if (value instanceof MimeNode) return value;
  if (value && typeof value === "object" && "type" in value && "value" in value && "node" in value
    && (value.type === "body" || value.type === "data") && Buffer.isBuffer(value.value) && value.node instanceof MimeNode) {
    return value.type === "body" && value.node instanceof MimeNode
      ? { type: "body", value: value.value, node: value.node }
      : { type: "data", value: value.value, node: value.node };
  }
  throw new MimeProjectionError("malformed");
}
/** Narrow transfer-encoding policy checks around the OSS decoder, not a MIME/RFC validator. */
function transferCheck(encoding: string | false) {
  let quartet = "", padded = false, quoted = "";
  if (encoding && !["base64", "quoted-printable", "7bit", "8bit", "binary"].includes(encoding)) throw new MimeProjectionError("unsupported");
  return {
    add(bytes: Buffer) {
      if (encoding !== "base64" && encoding !== "quoted-printable") return;
      for (const byte of bytes) {
        if (encoding === "base64") {
          if ([9, 10, 13, 32].includes(byte)) continue;
          if (padded || !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 43 || byte === 47 || byte === 61)) throw new MimeProjectionError("malformed");
          quartet += String.fromCharCode(byte);
          if (quartet.length === 4) {
            if (!/^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/.test(quartet)) throw new MimeProjectionError("malformed");
            padded = quartet.includes("="); quartet = "";
          }
        } else if (quoted) {
          quoted += String.fromCharCode(byte);
          if (quoted === "=\n" || quoted === "=\r\n" || /^=[A-Fa-f0-9]{2}$/.test(quoted)) quoted = "";
          else if (quoted !== "=\r" && !/^=[A-Fa-f0-9]$/.test(quoted)) throw new MimeProjectionError("malformed");
        } else if (byte === 61) quoted = "=";
      }
    },
    end() { if (quartet || quoted) throw new MimeProjectionError("malformed"); },
  };
}

/** Pinned mailsplit 5.4.16 hook: delegate MIME matching while accepting transport whitespace.
 * Only comparison bytes change; emitted original bytes and the original hash remain untouched. */
class TransportWhitespaceSplitter extends Splitter {
  compareBoundary(line: Buffer, start: number, boundary: Buffer): 1 | 2 | false {
    const compare: unknown = Reflect.get(Splitter.prototype, "compareBoundary");
    if (typeof compare !== "function") throw new MimeProjectionError("unsupported");
    let end = line.length;
    while (end && (line[end - 1] === 10 || line[end - 1] === 13)) end--;
    let contentEnd = end;
    while (contentEnd && (line[contentEnd - 1] === 32 || line[contentEnd - 1] === 9)) contentEnd--;
    const comparable = contentEnd === end ? line : Buffer.concat([line.subarray(0, contentEnd), line.subarray(end)]);
    const result: unknown = Reflect.apply(compare, this, [comparable, start, boundary]);
    if (result !== 1 && result !== 2 && result !== false) throw new MimeProjectionError("unsupported");
    return result;
  }
}

/** One pass from already durable original bytes. Sink writes are provisional until this promise resolves.
 * No filesystem, accounts, network, HTML rewriting, image expansion or original mutation. */
/** Adapt an already bounded MIME buffer to the parser's maximum source-chunk size. */
export function* mimeInputChunks(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
    yield bytes.subarray(offset, offset + 65536);
  }
}
export async function projectMime(input: MimeProjectionInput): Promise<MimeProjection> {
  const budget = limits(input.limits);
  if (!/^[a-f0-9]{64}$/.test(input.originalSha256) || typeof input.onAttachment !== "function" || !input.source
    || (!(Symbol.asyncIterator in Object(input.source)) && !(Symbol.iterator in Object(input.source)))) throw new MimeProjectionError("invalid_input");
  const expectedHash = input.originalSha256;
  const abort = new AbortController(), deadline = performance.now() + budget.timeoutMs;
  let failure: MimeProjectionError | undefined;
  const streams = new Set<{ destroy(error?: Error): unknown }>();
  let rejectStop: (error: MimeProjectionError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (code: MimeErrorCode) => {
    failure ??= new MimeProjectionError(code); abort.abort();
    for (const stream of streams) stream.destroy(failure);
    rejectStop(failure);
  };
  const guard = () => {
    if (failure) throw failure;
    if (performance.now() >= deadline) { stop("timeout"); throw failure; }
  };
  const cancel = () => stop("cancelled");
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop("timeout"), budget.timeoutMs);
  let inputBytes = 0, headerBytes = 0, bodyBytes = 0, attachmentBytes = 0, ordinal = 0;
  const originalHash = createHash("sha256");
  const projection: MimeProjection = { version: 1, originalSha256: expectedHash, validation: "supported-projection",
    metadata: { subject: null, from: null, to: null, cc: null, bcc: null, replyTo: null, date: null, messageId: null }, bodies: [], attachments: [] };
  async function* source() {
    try {
      for await (const bytes of input.source) {
        guard();
        if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 65536) throw new MimeProjectionError("invalid_input");
        inputBytes += bytes.byteLength;
        if (inputBytes > budget.maxInputBytes) throw new MimeProjectionError("limit");
        const owned = Buffer.from(bytes); originalHash.update(owned); yield owned;
      }
    } catch (error) { throw error instanceof MimeProjectionError && errorCodes.has(error.code) ? error : new MimeProjectionError("source_failed"); }
  }
  const parser = new TransportWhitespaceSplitter({ ignoreEmbedded: true, maxHeadSize: budget.maxHeaderBytes, maxChildNodes: budget.maxParts });
  const reader = Readable.from(source()); streams.add(reader); streams.add(parser);
  reader.on("error", error => { parser.destroy(error); });
  Readable.prototype.on.call(parser, "error", () => {});
  const iterator: AsyncIterator<unknown> = parser[Symbol.asyncIterator]();
  let pending: SplitterChunk | undefined;
  const next = async (): Promise<SplitterChunk | undefined> => {
    guard(); if (pending) { const value = pending; pending = undefined; return value; }
    const result = await iterator.next(); guard(); return result.done ? undefined : chunk(result.value);
  };
  const boundaries = new Map<string, boolean>();
  let boundaryLine = "", overlong = false, transportWhitespace = false;
  const scanData = (bytes: Buffer, final = false) => {
    for (const byte of bytes) {
      if (byte === 10) {
        const line = boundaryLine.replace(/\r$/, "");
        if (!overlong && line.startsWith("--") && line.endsWith("--")) {
          const boundary = line.slice(2, -2); if (boundaries.has(boundary)) boundaries.set(boundary, true);
        }
        boundaryLine = ""; overlong = false; transportWhitespace = false;
      } else if (!overlong) {
        if ((byte === 32 || byte === 9) && boundaryLine.startsWith("--") && boundaryLine.endsWith("--")) { transportWhitespace = true; continue; }
        if (transportWhitespace && byte !== 13) { overlong = true; continue; }
        if (boundaryLine.length < 80) boundaryLine += String.fromCharCode(byte); else { boundaryLine = ""; overlong = true; }
      }
    }
    if (final && boundaryLine) scanData(Buffer.from("\n"));
  };
  async function* decoded(node: MimeNode) {
    const check = transferCheck(node.encoding);
    async function* raw() {
      while (true) {
        const value = await next();
        if (!value) break;
        if (value.type !== "body") { pending = value; break; }
        check.add(value.value); yield value.value;
      }
      check.end();
    }
    const rawStream = Readable.from(raw()), decoder = node.getDecoder();
    streams.add(rawStream); streams.add(decoder);
    rawStream.on("error", error => decoder.destroy(error)); decoder.on("error", () => {}); rawStream.pipe(decoder);
    try {
      for await (const value of decoder) {
        guard(); if (!(value instanceof Uint8Array)) throw new MimeProjectionError("malformed");
        for (let offset = 0; offset < value.byteLength; offset += 65536) { guard(); yield Buffer.from(value.subarray(offset, offset + 65536)); }
      }
    } finally { rawStream.destroy(); decoder.destroy(); streams.delete(rawStream); streams.delete(decoder); }
  }
  const nodes: MimeNode[] = [], bodyNodes = new Map<MimeNode, MimeProjection["bodies"][number]>();
  const work = (async () => {
    if (input.signal?.aborted) stop("cancelled");
    guard(); reader.pipe(parser);
    while (true) {
      const value = await next(); if (!value) break;
      if (value.type === "data") { scanData(value.value); continue; }
      if (value.type !== "node" || !value.headers) throw new MimeProjectionError("malformed");
      scanData(Buffer.alloc(0), true); boundaryLine = ""; overlong = false; transportWhitespace = false;
      nodes.push(value);
      ordinal++; if (ordinal > budget.maxParts) throw new MimeProjectionError("limit");
      let depth = 1, parent = value.parentNode;
      while (parent) { depth++; parent = parent.parentNode; if (depth > budget.maxDepth) throw new MimeProjectionError("limit"); }
      headerBytes += value.getHeaders().byteLength; if (headerBytes > budget.maxHeaderBytes) throw new MimeProjectionError("limit");
      const headers = value.headers;
      if (headers.mbox || headers.http || headers.getList().some(line => !/^[!-9;-~]+$/.test(line.key))) throw new MimeProjectionError("malformed");
      for (const name of ["content-type", "content-transfer-encoding", "content-disposition"]) if (headers.get(name).length > 1) throw new MimeProjectionError("malformed");
      const header = (name: string) => clean(libmime.decodeWords(headers.getFirst(name)));
      if (ordinal === 1) {
        const dateValue = header("date"), timestamp = dateValue === null ? NaN : Date.parse(dateValue);
        projection.metadata = { subject: header("subject"), from: header("from"), to: header("to"), cc: header("cc"), bcc: header("bcc"),
          replyTo: header("reply-to"), date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, messageId: header("message-id") };
      }
      if (value.multipart) {
        const boundary = libmime.parseHeaderValue(headers.getFirst("content-type")).params.boundary;
        if (!boundary || !/^[\x21-\x7e]{1,70}$/.test(boundary) || boundaries.has(boundary)) throw new MimeProjectionError("unsupported");
        boundaries.set(boundary, false); continue;
      }
      const partId = `mime-v1:${expectedHash}:part:${ordinal}`, contentType = value.contentType || "application/octet-stream";
      if (contentType.length > 256 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) throw new MimeProjectionError("unsupported");
      const isBody = (contentType === "text/plain" || contentType === "text/html") && value.disposition !== "attachment" && !value.filename;
      if (isBody && (contentType === "text/plain" || contentType === "text/html")) {
        const charset = value.charset || "utf-8";
        if (!iconv.encodingExists(charset)) throw new MimeProjectionError("unsupported");
        const convert = iconv.getDecoder(charset), pieces: string[] = []; let rawBytes = 0;
        const append = (text: string) => { bodyBytes += Buffer.byteLength(text); if (bodyBytes > budget.maxBodyBytes) throw new MimeProjectionError("limit"); pieces.push(text); };
        for await (const bytes of decoded(value)) { rawBytes += bytes.byteLength; if (rawBytes > budget.maxBodyBytes) throw new MimeProjectionError("limit"); append(convert.write(bytes)); }
        append(convert.end() || "");
        const collected = pieces.join("");
        const body = contentType === "text/plain" && value.flowed ? libmime.decodeFlowed(collected, value.delSp) : collected;
        bodyBytes += Buffer.byteLength(body) - Buffer.byteLength(collected);
        guard(); if (bodyBytes > budget.maxBodyBytes) throw new MimeProjectionError("limit");
        const entry: MimeProjection["bodies"][number] = { partId, contentType, text: body };
        projection.bodies.push(entry); bodyNodes.set(value, entry);
      } else {
        if (projection.attachments.length >= budget.maxAttachments) throw new MimeProjectionError("limit");
        const part: MimeAttachmentMetadata = { partId, filename: clean(value.filename), contentType,
          disposition: value.disposition === "inline" ? "inline" : "attachment", contentId: clean(headers.getFirst("content-id"))?.replace(/^<|>$/g, "") || null };
        const attachmentNode = value;
        let bytes = 0, consumed = false; const digest = createHash("sha256");
        async function* content() {
          for await (const data of decoded(attachmentNode)) {
            guard(); bytes += data.byteLength; attachmentBytes += data.byteLength;
            if (bytes > budget.maxAttachmentBytes || attachmentBytes > budget.maxTotalAttachmentBytes) throw new MimeProjectionError("limit");
            digest.update(data); yield data;
          }
          consumed = true;
        }
        try { await input.onAttachment(part, content(), abort.signal); }
        catch (error) { throw error instanceof MimeProjectionError && errorCodes.has(error.code) ? error : new MimeProjectionError("sink_failed"); }
        guard(); if (!consumed) throw new MimeProjectionError("sink_failed");
        projection.attachments.push({ ...part, bytes, sha256: digest.digest("hex") });
      }
    }
    scanData(Buffer.alloc(0), true);
    if (!ordinal || [...boundaries.values()].some(closed => !closed)) throw new MimeProjectionError("malformed");
    if (originalHash.digest("hex") !== expectedHash) throw new MimeProjectionError("hash_mismatch");
    // RFC 2046 alternatives are ordered by fidelity; related resources are not
    // independent message bodies. Keep all decoded text for search/source, but
    // mark only the chosen branch for each presentation type.
    const children = new Map<MimeNode, MimeNode[]>();
    for (const node of nodes) if (node.parentNode) { const list=children.get(node.parentNode)??[];list.push(node);children.set(node.parentNode,list); }
    function selected(node:MimeNode,type:string):MimeProjection["bodies"] {
      const body=bodyNodes.get(node);if(body)return body.contentType===type?[body]:[];
      const list=children.get(node)??[];
      if(node.contentType==='multipart/alternative'){for(const child of [...list].reverse()){const result=selected(child,type);if(result.length)return result;}return [];}
      if(node.contentType==='multipart/related'){
        const start=libmime.parseHeaderValue(node.headers?node.headers.getFirst('content-type'):'').params.start;
        const root=start?list.find(child=>child.headers&&child.headers.getFirst('content-id')===start):list[0];
        return root?selected(root,type):[];
      }
      return list.flatMap(child=>selected(child,type));
    }
    const root=nodes[0],visible=new Set(root?[...selected(root,'text/html'),...selected(root,'text/plain')]:[]);
    for(const body of projection.bodies)body.presentation=visible.has(body);
    guard(); return projection;
  })();
  try { return await Promise.race([work, stopped]); }
  catch (error) {
    const code = error instanceof MimeProjectionError && errorCodes.has(error.code) ? error.code : error && typeof error === "object" && "code" in error && error.code === "EMAXLEN" ? "limit" : "malformed";
    stop(code); throw failure;
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", cancel);
    for (const stream of streams) stream.destroy();
  }
}
