import { randomUUID } from "node:crypto";
import { z } from "zod";
import { storageInputSchema, storageSearchSchema, STORAGE_MAX_FILE_BYTES } from "../file-storage/schema.js";
import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { conflict, ensureFileSize, hashVersion, storagePath, unsupportedSearch } from "../file-storage/common.js";
import { withStorage } from "../file-storage/service.js";
import { mergeStorageSecrets, publicConnection, StorageStore } from "../file-storage/store.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type Options = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
};

const writeSchema = z.object({
  path: z.string(),
  dataBase64: z.string(),
  contentType: z
    .string()
    .max(200)
    .regex(/^[\x20-\x7e]*$/)
    .default("application/octet-stream"),
  version: z.string().min(1).max(1000).optional(),
});

export function registerStorageRoutes({
  routes,
  config,
  jsonResponse,
  readJsonBodyLimited,
  ensureWritable,
  requireClientScope,
  resolveWorkspace,
}: Options) {
  const store = new StorageStore(config);
  // File-server protocols lack conditional writes. Serialize this server's
  // mutations so two LegalWork saves cannot both pass the same version check.
  const pendingWrites = new Map<string, Promise<unknown>>();
  const serializeWrite = async <T>(key: string, write: () => Promise<T>): Promise<T> => {
    const pending = (pendingWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(write);
    pendingWrites.set(key, pending);
    try {
      return await pending;
    } finally {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
    }
  };
  const base = "/workspace/:id/storage";
  const workspace = async (ctx: RequestContext) => (await resolveWorkspace(config, ctx.params.id)).id;
  const canWrite = (ctx: RequestContext) =>
    !config.readOnly &&
    (ctx.actor?.type === "host" || ctx.actor?.scope === "owner" || ctx.actor?.scope === "collaborator");
  const selected = async (ctx: RequestContext, writing = false) => {
    const item = await store.get(await workspace(ctx), ctx.params.storageId);
    if (!item.enabled)
      throw new ApiError(409, "storage_disabled", "Enable this storage connection in Integrations first.");
    if (writing) {
      requireClientScope(ctx, "collaborator");
      ensureWritable(config);
      if (item.readOnly)
        throw new ApiError(
          403,
          "storage_read_only",
          "This storage is read-only. Change its access in Integrations to write files.",
        );
    }
    return item;
  };
  const parsedInput = async (ctx: RequestContext, id?: string) => {
    const parsed = storageInputSchema.safeParse(await readJsonBodyLimited(ctx.request, 128 * 1024));
    if (!parsed.success)
      throw new ApiError(
        400,
        "invalid_storage_configuration",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    const previous = id ? await store.get(await workspace(ctx), id) : undefined;
    return mergeStorageSecrets(parsed.data, previous);
  };
  addRoute(routes, "GET", base, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    return jsonResponse({ connections: (await store.list(await workspace(ctx))).map(publicConnection) });
  });
  addRoute(routes, "GET", `${base}/roots`, "client", async (ctx) => {
    const connections = await store.list(await workspace(ctx));
    return jsonResponse({
      roots: connections
        .filter((item) => item.enabled)
        .map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.config.kind,
          writable: !item.readOnly && canWrite(ctx),
        })),
    });
  });
  for (const method of ["POST", "PUT"]) {
    addRoute(routes, method, method === "POST" ? base : `${base}/:storageId`, "host", async (ctx) => {
      requireClientScope(ctx, "owner");
      ensureWritable(config);
      const input = await parsedInput(ctx, ctx.params.storageId);
      // Test on demand; saving an unavailable connection is useful for offline networks.
      // Credentials are never tested by writing a probe into a customer's storage.
      const connection = await store.save(await workspace(ctx), input, ctx.params.storageId);
      return jsonResponse({ connection }, method === "POST" ? 201 : 200);
    });
  }
  addRoute(routes, "POST", `${base}/test`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    const id = ctx.url.searchParams.get("connectionId") ?? undefined;
    const input = await parsedInput(ctx, id);
    await withStorage(input, (adapter) => adapter.list(""));
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "DELETE", `${base}/:storageId`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await store.remove(await workspace(ctx), ctx.params.storageId);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "GET", `${base}/:storageId/capabilities`, "client", async (ctx) => {
    const connection = await selected(ctx);
    const writable = !connection.readOnly && canWrite(ctx);
    const search = await withStorage(
      connection,
      (adapter) => adapter.searchCapabilities?.() ?? Promise.resolve({ modes: [], pagination: false }),
    );
    return jsonResponse({ read: true, write: writable, createFolder: writable, search });
  });
  addRoute(routes, "GET", `${base}/:storageId/search`, "client", async (ctx) => {
    const connection = await selected(ctx);
    const parsed = storageSearchSchema.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!parsed.success)
      throw new ApiError(
        400,
        "invalid_storage_search",
        "Provide a supported search mode, query, and relative folder path.",
      );
    storagePath(parsed.data.path);
    return jsonResponse(
      await withStorage(connection, (adapter) => (adapter.search ? adapter.search(parsed.data) : unsupportedSearch())),
    );
  });
  addRoute(routes, "GET", `${base}/:storageId/children`, "client", async (ctx) => {
    const connection = await selected(ctx);
    const path = storagePath(ctx.url.searchParams.get("path") ?? "");
    const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
    if (cursor && cursor.length > 16_384) throw new ApiError(400, "invalid_storage_cursor", "Invalid folder page.");
    return jsonResponse(await withStorage(connection, (adapter) => adapter.list(path, cursor)));
  });
  addRoute(routes, "GET", `${base}/:storageId/file`, "client", async (ctx) => {
    const connection = await selected(ctx);
    const path = storagePath(ctx.url.searchParams.get("path") ?? "", false);
    const result = await withStorage(connection, (adapter) => adapter.read(path));
    return jsonResponse({
      dataBase64: result.data.toString("base64"),
      contentType: result.contentType ?? "application/octet-stream",
      version: result.version,
      writable:
        !connection.readOnly &&
        canWrite(ctx) &&
        !result.version.startsWith("sha256:") &&
        !result.version.startsWith("W/"),
    });
  });
  for (const method of ["POST", "PUT"]) {
    addRoute(routes, method, `${base}/:storageId/file`, "client", async (ctx) => {
      const connection = await selected(ctx, true);
      const parsed = writeSchema.safeParse(
        await readJsonBodyLimited(ctx.request, Math.ceil((STORAGE_MAX_FILE_BYTES * 4) / 3) + 32 * 1024),
      );
      if (!parsed.success)
        throw new ApiError(
          400,
          "invalid_storage_file",
          "Provide a file path, base64 content, and the file version when saving changes.",
        );
      const input = parsed.data;
      const path = storagePath(input.path, false);
      if (method === "PUT" && !input.version)
        throw new ApiError(400, "storage_version_required", "Reload this file before saving changes.");
      if (input.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))
        throw new ApiError(400, "invalid_storage_file", "File content is not valid base64.");
      const data = Buffer.from(input.dataBase64, "base64");
      ensureFileSize(data.length);
      const result = await serializeWrite(`${connection.id}/${path}`, () =>
        withStorage(connection, async (adapter) => {
          await adapter.write(
            path,
            data,
            input.contentType,
            method === "POST" ? { createOnly: true } : { version: input.version },
          );
          const saved = await adapter.read(path);
          // Do not return another writer's version as the base for a subsequent save.
          if (hashVersion(saved.data) !== hashVersion(data)) conflict();
          return { version: saved.version };
        }),
      );
      await recordAudit((await resolveWorkspace(config, ctx.params.id)).path, {
        id: randomUUID(),
        timestamp: Date.now(),
        workspaceId: connection.workspaceId,
        actor: ctx.actor!,
        action: method === "POST" ? "storage.upload" : "storage.write",
        target: connection.id,
        summary: `${method === "POST" ? "Uploaded" : "Saved"} ${path}`,
      });
      return jsonResponse({ ok: true, ...result }, method === "POST" ? 201 : 200);
    });
  }
  addRoute(routes, "POST", `${base}/:storageId/folders`, "client", async (ctx) => {
    const connection = await selected(ctx, true);
    const body = await readJsonBodyLimited(ctx.request, 8 * 1024);
    if (typeof body.path !== "string") throw new ApiError(400, "invalid_storage_path", "A folder path is required.");
    const path = storagePath(body.path, false);
    await serializeWrite(`${connection.id}/${path}`, () => withStorage(connection, (adapter) => adapter.mkdir(path)));
    return jsonResponse({ ok: true }, 201);
  });
}
