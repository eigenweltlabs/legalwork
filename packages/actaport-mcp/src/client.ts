import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ACTAPORT_ORIGIN, ActaportError, type TokenProvider } from "./auth.js";
import { isRecord, pathParameters, type Operation } from "./spec.js";

const JSON_LIMIT = 10 * 1024 * 1024;
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const FILE_LIMIT = 60 * 1024 * 1024;
const resultHeaders = ["location", "tus-resumable", "tus-version", "tus-extension", "tus-max-size", "upload-offset", "upload-length", "upload-expires", "content-type"];

async function bytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) throw new ActaportError("response_too_large", "Actaport response exceeds the size limit.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body) for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > limit) throw new ActaportError("response_too_large", "Actaport response exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function inside(root: string, path: string) {
  const remainder = relative(root, path);
  return remainder !== ".." && !remainder.startsWith("../") && !remainder.startsWith("..\\") && !isAbsolute(remainder);
}

export class ActaportClient {
  constructor(private readonly token: TokenProvider, private readonly options: {
    fetch?: typeof fetch; origin?: string; fileRoot?: string; allowWrites?: boolean;
    isOperationEnabled?: (operation: Operation) => boolean;
  } = {}) {}

  async execute(operation: Operation, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!operation.validate(input)) throw new ActaportError("invalid_arguments", `Invalid arguments: ${operation.validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`);
    if (!operation.readOnly && !this.options.allowWrites) throw new ActaportError("read_only", "Actaport writes are disabled. Enable write access in connection settings.");
    const checkToolset = () => {
      if (this.options.isOperationEnabled?.(operation) === false) throw new ActaportError("tool_disabled", "This tool group is disabled. Select it in Actaport connection settings.");
    };
    checkToolset();
    let path = operation.path;
    for (const field of pathParameters(path)) path = path.replace(field.template, encodeURIComponent(String(input[field.name])));
    const origin = this.options.origin ?? ACTAPORT_ORIGIN;
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/v1/")) throw new ActaportError("invalid_endpoint", "Invalid Actaport API endpoint.");
    const headers = new Headers({ Accept: "application/json, application/octet-stream" });
    for (const parameter of operation.parameters) {
      const value = input[parameter.name];
      if (value === undefined) continue;
      if (parameter.in === "query") {
        if (Array.isArray(value)) {
          if (parameter.explode === false) url.searchParams.set(parameter.name, value.map(String).join(","));
          else for (const item of value) url.searchParams.append(parameter.name, String(item));
        } else url.searchParams.set(parameter.name, String(value));
      } else if (parameter.in === "header") headers.set(parameter.name, Array.isArray(value) ? value.map(String).join(",") : String(value));
    }
    const body = await this.body(operation, input.body, headers);
    let access = await this.token();
    const request = async () => {
      if (!operation.readOnly && !this.options.allowWrites) throw new ActaportError("read_only", "Actaport writes are disabled.");
      checkToolset();
      headers.set("Authorization", `Bearer ${access.accessToken}`);
      try {
        return await (this.options.fetch ?? fetch)(url, { method: operation.method, headers, body,
          redirect: "manual", signal: AbortSignal.timeout(60_000) });
      } catch { throw new ActaportError("api_unreachable", "Actaport request failed. The operation may have completed; check its state before repeating a write."); }
    };
    let response = await request();
    if (response.status === 401) {
      await response.body?.cancel();
      access = await this.token(true);
      response = await request();
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = Number(response.headers.get("Retry-After"));
      const messages: Record<number, [string, string]> = {
        401: ["reconnect_required", "Reconnect Actaport to restore API access."],
        403: ["permission_denied", "This API user does not have permission for the requested operation."],
        404: ["not_found", "The requested Actaport record was not found."],
        409: ["conflict", "The operation conflicts with the current Actaport record. Read its state before retrying."],
        423: ["locked", "The Actaport record is locked."],
        429: ["rate_limited", "Actaport rate limit reached. Wait before retrying."],
      };
      const [code, message] = messages[response.status] ?? ["api_failed", "Actaport could not complete this request."];
      throw new ActaportError(code, message, response.status, response.status === 429 && Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    const metadata = Object.fromEntries(resultHeaders.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }));
    if (operation.method === "HEAD" || response.status === 204 || response.status === 201 && operation.operationId === "downloadDocument") {
      await response.body?.cancel();
      return { status: response.status, headers: metadata };
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const data = await bytes(response, JSON_LIMIT);
      try { return { status: response.status, data: JSON.parse(data.toString("utf8")), headers: metadata }; }
      catch { throw new ActaportError("invalid_response", "Actaport returned invalid JSON."); }
    }
    if (operation.operationId === "downloadDocument" && typeof input.saveTo === "string") {
      return { status: response.status, file: await this.save(response, input.saveTo), headers: metadata };
    }
    const data = await bytes(response, JSON_LIMIT);
    return { status: response.status, ...(type.startsWith("text/") ? { text: data.toString("utf8") } : { base64: data.toString("base64") }), headers: metadata };
  }

  private async filePath(path: string, existing: boolean) {
    const root = await realpath(this.options.fileRoot ?? process.cwd());
    const target = resolve(root, path);
    const checked = existing ? await realpath(target) : resolve(await realpath(dirname(target)), target.split(/[\\/]/).pop() ?? "");
    if (!inside(root, target) || !inside(root, checked)) throw new ActaportError("invalid_file_path", "Files must be inside the MCP file root.");
    return checked;
  }

  private async body(operation: Operation, value: unknown, headers: Headers): Promise<BodyInit | undefined> {
    if (value === undefined) return undefined;
    if (operation.contentType === "multipart/form-data") {
      if (!isRecord(value) || typeof value.file !== "string") throw new ActaportError("invalid_arguments", "A file path is required.");
      const path = await this.filePath(value.file, true);
      const handle = await open(path, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > UPLOAD_LIMIT) throw new ActaportError("file_too_large", "Multipart uploads require a regular file of at most 50 MB. Use TUS for larger files.");
        const content = await handle.readFile();
        const form = new FormData();
        form.set("file", new Blob([content]), path.split(/[\\/]/).pop());
        for (const [key, item] of Object.entries(value)) if (key !== "file" && item !== undefined) form.set(key, String(item));
        return form;
      } finally { await handle.close(); }
    }
    if (operation.contentType === "application/offset+octet-stream") {
      if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ActaportError("invalid_arguments", "TUS chunks must be valid base64.");
      const data = Buffer.from(value, "base64");
      if (data.byteLength > JSON_LIMIT) throw new ActaportError("file_too_large", "TUS chunks must be at most 10 MB.");
      headers.set("Content-Type", operation.contentType);
      return data;
    }
    if (!operation.contentType) throw new ActaportError("invalid_arguments", "This operation does not declare a request body.");
    headers.set("Content-Type", operation.contentType);
    return operation.contentType === "application/json" ? JSON.stringify(value) : String(value);
  }

  private async save(response: Response, destination: string) {
    const path = await this.filePath(destination, false);
    // Exclusive creation rejects existing files and symlinks; never overwrite user work.
    const handle = await open(path, "wx", 0o600);
    let length = 0;
    try {
      if (Number(response.headers.get("content-length")) > FILE_LIMIT) throw new ActaportError("file_too_large", "Direct downloads are limited to 60 MB. Use Actaport's asynchronous download resource.");
      if (response.body) for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > FILE_LIMIT) throw new ActaportError("file_too_large", "Direct downloads are limited to 60 MB.");
        await handle.writeFile(chunk);
      }
      return { path, bytes: length };
    } catch (error) {
      await handle.close();
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
      throw error;
    } finally { await handle.close(); }
  }
}
