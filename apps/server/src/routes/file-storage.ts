import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { workingCopy, snapshotWorkspaceFile, keepWorkspaceCopy } from "../file-storage/working-copy.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  storageInputSchema,
  storageSearchSchema,
  storageFilenameSearchSchema,
  STORAGE_MAX_FILE_BYTES,
} from "../file-storage/schema.js";
import { searchFilenames } from "../file-storage/filename-search.js";
import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import {
  conflict,
  ensureFileSize,
  hashVersion,
  receiveFile,
  storagePath,
  unsupportedSearch,
} from "../file-storage/common.js";
import { withStorage } from "../file-storage/service.js";
import { StorageOAuth } from "../file-storage/oauth/session.js";
import { oauthProviders } from "../file-storage/oauth/providers.js";
import { TeamStorage, isTeamStorage, teamStorageId } from "../file-storage/team.js";
import { mergeStorageSecrets, publicConnection, StorageStore } from "../file-storage/store.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type Options = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
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
  requireApproval,
  requireClientScope,
  resolveWorkspace,
}: Options) {
  const store = new StorageStore(config);
  const team = new TeamStorage(config);
  const oauth = new StorageOAuth(join(dirname(store.path), "storage-oauth.vault"));
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
  const lookup = async (workspaceId: string, id: string) => {
    const item = isTeamStorage(id)
      ? (await team.list(workspaceId)).connections.find((item) => item.id === id)
      : await store.get(workspaceId, id);
    if (!item)
      throw new ApiError(404, "storage_not_found", "This team connection is unavailable. Refresh Memory Drive.");
    return item;
  };
  const selected = async (ctx: RequestContext, writing = false) => {
    const item = await lookup(await workspace(ctx), ctx.params.storageId);
    if (item.team?.installed === false)
      throw new ApiError(409, "storage_not_installed", "Add this connection from the Team tab in File storage first.");
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
    oauth.bind(await workspace(ctx), item.id, item);
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
    const previous = id ? await lookup(await workspace(ctx), id) : undefined;
    const input = mergeStorageSecrets(parsed.data, previous);
    if (id) oauth.bind(await workspace(ctx), id, input);
    return input;
  };
  addRoute(routes, "GET", `${base}/oauth/providers`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    return jsonResponse({ providers: oauthProviders.filter((p) => p.clientId).map(({ id, name, rootHint }) => ({ id, name, rootHint })) });
  });
  addRoute(routes, "GET", `${base}/:storageId/oauth`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    const id = await workspace(ctx);
    const item = await lookup(id, ctx.params.storageId);
    return jsonResponse(await oauth.status(oauth.key(id, item.id, item)));
  });
  addRoute(routes, "POST", `${base}/:storageId/oauth`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const item = await selected(ctx);
    const id = await workspace(ctx);
    const key = oauth.key(id, item.id, item);
    return jsonResponse(await oauth.start(key, item, async () => {
      try {
        const current = await lookup(id, item.id);
        return current.enabled && current.team?.installed !== false && oauth.key(id, current.id, current) === key;
      } catch { return false; }
    }));
  });
  addRoute(routes, "DELETE", `${base}/:storageId/oauth`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const id = await workspace(ctx);
    const item = await lookup(id, ctx.params.storageId);
    await oauth.disconnect(oauth.key(id, item.id, item));
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "GET", base, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    const workspaceId = await workspace(ctx);
    const shared = await team.list(workspaceId);
    return jsonResponse({
      connections: [...(await store.list(workspaceId)), ...shared.connections].map(publicConnection),
      team: shared.status,
    });
  });
  addRoute(routes, "GET", `${base}/roots`, "client", async (ctx) => {
    const workspaceId = await workspace(ctx);
    const shared = await team.list(workspaceId);
    const connections = [...(await store.list(workspaceId)), ...shared.connections];
    return jsonResponse({
      ...(shared.status.error ? { teamError: shared.status.error } : {}),
      roots: connections
        .filter((item) => item.enabled && item.team?.installed !== false)
        .map((item) => ({
          id: item.id,
          name: item.name,
          revision: item.team ? `${item.team.orgId}:${item.team.version}` : String(item.updatedAt),
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
      if (ctx.params.storageId) {
        const id = await workspace(ctx);
        const previous = await lookup(id, ctx.params.storageId);
        if (JSON.stringify(previous.config) !== JSON.stringify(input.config) || previous.readOnly !== input.readOnly || !input.enabled)
          await oauth.disconnect(oauth.key(id, previous.id, previous));
      }
      if (method === "PUT" && isTeamStorage(ctx.params.storageId)) {
        const version = z.coerce.number().int().positive().safeParse(ctx.url.searchParams.get("version"));
        if (!version.success)
          throw new ApiError(400, "storage_version_required", "Refresh and reopen this team connection before saving.");
        const workspaceId = await workspace(ctx);
        await team.request(workspaceId, "PUT", `/${teamStorageId(ctx.params.storageId)}`, {
          input,
          version: version.data,
        });
        team.invalidate(workspaceId);
        const connection = (await team.list(workspaceId, true)).connections.find(
          (item) => item.id === ctx.params.storageId,
        );
        if (!connection)
          throw new ApiError(503, "storage_team_unavailable", "Saved for your firm. Refresh to sync this connection.");
        return jsonResponse({ connection: publicConnection(connection) });
      }
      // Test on demand; saving an unavailable connection is useful for offline networks.
      // Credentials are never tested by writing a probe into a customer's storage.
      const connection = await store.save(await workspace(ctx), input, ctx.params.storageId);
      return jsonResponse({ connection }, method === "POST" ? 201 : 200);
    });
  }
  addRoute(routes, "POST", `${base}/team`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const workspaceId = await workspace(ctx);
    const raw = await readJsonBodyLimited(ctx.request, 128 * 1024);
    const localId = typeof raw.localId === "string" ? raw.localId : undefined;
    const input = localId ? await store.get(workspaceId, localId) : storageInputSchema.safeParse(raw);
    if ("success" in input && !input.success)
      throw new ApiError(400, "invalid_storage_configuration", "Check the connection fields.");
    const parsed = storageInputSchema.safeParse({
      ...("success" in input ? input.data : input),
      ...(localId && raw.teamInstallation !== undefined ? { teamInstallation: raw.teamInstallation } : {}),
    });
    if (!parsed.success) throw new ApiError(400, "invalid_storage_configuration", "Check the connection fields.");
    const value = parsed.data;
    const saved = await team.request(workspaceId, "POST", "", value);
    team.invalidate(workspaceId);
    if (localId && value.teamInstallation === "optional") {
      const result = z.object({ connection: z.object({ id: z.string().uuid() }) }).safeParse(saved);
      if (!result.success)
        throw new ApiError(
          502,
          "storage_team_unavailable",
          "Shared with your firm. Refresh to add the team connection.",
        );
      await team.setInstalled(workspaceId, `team:${result.data.connection.id}`, true);
    }
    // Promotion is explicit and the platform save has succeeded. Remove only
    // this local copy so it does not appear twice in the administrator's app.
    if (localId) await store.remove(workspaceId, localId);
    team.invalidate(workspaceId);
    return jsonResponse({ ok: true }, 201);
  });
  addRoute(routes, "POST", `${base}/test`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    const id = ctx.url.searchParams.get("connectionId") ?? undefined;
    const input = await parsedInput(ctx, id);
    await withStorage(input, (adapter) => adapter.list(""));
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", `${base}/:storageId/installation`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const input = z.object({ installed: z.boolean() }).safeParse(await readJsonBodyLimited(ctx.request, 1024));
    if (!input.success)
      throw new ApiError(400, "invalid_storage_installation", "Choose whether to add this connection.");
    await team.setInstalled(await workspace(ctx), ctx.params.storageId, input.data.installed);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "DELETE", `${base}/:storageId`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const workspaceId = await workspace(ctx);
    if (isTeamStorage(ctx.params.storageId)) {
      const version = z.coerce.number().int().positive().safeParse(ctx.url.searchParams.get("version"));
      if (!version.success)
        throw new ApiError(400, "storage_version_required", "Refresh this team connection before removing it.");
      await team.request(workspaceId, "DELETE", `/${teamStorageId(ctx.params.storageId)}`, { version: version.data });
      team.invalidate(workspaceId);
    } else {
      const item = await store.get(workspaceId, ctx.params.storageId);
      await oauth.disconnect(oauth.key(workspaceId, item.id, item));
      await store.remove(workspaceId, ctx.params.storageId);
    }
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
  addRoute(routes, "POST", `${base}/:storageId/filename-search`, "client", async (ctx) => {
    const connection = await selected(ctx);
    const parsed = storageFilenameSearchSchema.safeParse(await readJsonBodyLimited(ctx.request, 128 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_storage_search", "Enter a filename or path to search for.");
    storagePath(parsed.data.path);
    return jsonResponse(
      await withStorage(connection, (adapter) =>
        searchFilenames(adapter, parsed.data, `${connection.id}:${connection.updatedAt}`, ctx.request.signal),
      ),
    );
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
        result.writable !== false &&
        canWrite(ctx) &&
        !result.version.startsWith("sha256:") &&
        !result.version.startsWith("W/"),
    });
  });
  addRoute(routes, "POST", `${base}/:storageId/checkout`, "client", async (ctx) => {
    const connection = await selected(ctx);
    const parsed = z.object({ path: z.string() }).safeParse(await readJsonBodyLimited(ctx.request, 8 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_storage_path", "A file path is required.");
    const path = storagePath(parsed.data.path, false);
    const current = await resolveWorkspace(config, ctx.params.id);
    const metadata = await withStorage(connection, (adapter) => adapter.stat(path));
    const copy = await workingCopy(current.path, metadata?.name ? storagePath(metadata.name, false) : path);
    try {
      const file = await withStorage(connection, (adapter) => adapter.download(path, copy.path));
      return jsonResponse({
        localPath: copy.relativePath,
        version: file.version,
        size: file.size,
        contentType: file.contentType ?? "application/octet-stream",
        updatedAt: (await stat(copy.path)).mtimeMs,
        writable:
          !connection.readOnly &&
          file.writable !== false &&
          canWrite(ctx) &&
          !file.version.startsWith("sha256:") &&
          !file.version.startsWith("W/"),
        localWritable: canWrite(ctx),
      });
    } catch (error) {
      await copy.remove();
      throw error;
    }
  });
  addRoute(routes, "POST", `${base}/:storageId/local-copy`, "client", async (ctx) => {
    await selected(ctx);
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    const parsed = z
      .object({ localPath: z.string(), targetPath: z.string() })
      .safeParse(await readJsonBodyLimited(ctx.request, 16 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_storage_path", "Choose a workspace file and destination.");
    const current = await resolveWorkspace(config, ctx.params.id);
    const destination = storagePath(parsed.data.targetPath, false);
    await requireApproval(ctx, {
      workspaceId: current.id,
      action: "workspace.file.write",
      summary: `Save local copy ${destination}`,
      paths: [join(current.path, destination)],
    });
    const saved = await keepWorkspaceCopy(current.path, parsed.data.localPath, destination);
    await recordAudit(current.path, {
      id: randomUUID(),
      timestamp: Date.now(),
      workspaceId: current.id,
      actor: ctx.actor!,
      action: "workspace.file.write",
      target: destination,
      summary: `Saved local copy ${destination}`,
    });
    return jsonResponse(saved, 201);
  });
  // Raw uploads and workspace saves share version checks, serialization, and read-back verification.
  for (const endpoint of ["content", "from-workspace"]) {
    for (const method of endpoint === "content" ? ["POST", "PUT"] : ["POST"]) {
      addRoute(routes, method, `${base}/:storageId/${endpoint}`, "client", async (ctx) => {
        const connection = await selected(ctx, true);
        const raw =
          endpoint === "content"
            ? {
                ...Object.fromEntries(ctx.url.searchParams),
                mode: method === "POST" ? "create" : "replace",
                contentType: ctx.request.headers.get("content-type") ?? undefined,
              }
            : await readJsonBodyLimited(ctx.request, 32 * 1024);
        const parsed = z
          .object({
            path: z.string(),
            localPath: z.string().optional(),
            mode: z.enum(["create", "replace"]),
            version: writeSchema.shape.version,
            contentType: writeSchema.shape.contentType,
          })
          .safeParse(raw);
        if (!parsed.success)
          throw new ApiError(400, "invalid_storage_file", "Provide a file path and version when replacing a file.");
        const input = parsed.data;
        const path = storagePath(input.path, false);
        if (input.mode === "replace" && !input.version)
          throw new ApiError(400, "storage_version_required", "Reload this file before saving changes.");
        const current = await resolveWorkspace(config, ctx.params.id);
        const staged = await (async () => {
          if (endpoint === "from-workspace") {
            if (!input.localPath) throw new ApiError(400, "invalid_storage_file", "Choose a workspace file.");
            return snapshotWorkspaceFile(current.path, input.localPath);
          }
          const directory = await mkdtemp(join(tmpdir(), "legalwork-upload-"));
          const target = join(directory, "content");
          try {
            const body = ctx.request.body;
            const received = await receiveFile(body ?? Readable.from([]), target);
            return { path: target, ...received, remove: () => rm(directory, { recursive: true, force: true }) };
          } catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw error;
          }
        })();
        try {
          const result = await serializeWrite(`${connection.id}/${path}`, () =>
            withStorage(connection, async (adapter) => {
              await adapter.upload(
                path,
                staged.path,
                input.contentType,
                input.mode === "create" ? { createOnly: true } : { version: input.version },
              );
              const saved = await adapter.download(path);
              if (saved.sha256 !== staged.sha256) conflict();
              return { version: saved.version };
            }),
          );
          await recordAudit(current.path, {
            id: randomUUID(),
            timestamp: Date.now(),
            workspaceId: connection.workspaceId,
            actor: ctx.actor!,
            action: input.mode === "create" ? "storage.upload" : "storage.write",
            target: connection.id,
            summary: `${input.mode === "create" ? "Uploaded" : "Saved"} ${path}`,
          });
          return jsonResponse({ ok: true, ...result }, input.mode === "create" ? 201 : 200);
        } finally {
          await staged.remove();
        }
      });
    }
  }
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
