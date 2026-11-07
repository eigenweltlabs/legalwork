import { projectFilePath } from "../project-file-schema.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { attachFile, attachedFile, fileField } from "./files.js";
import { loadAttachedFile } from "./file-sync.js";
import { BACK_OFFICE_FILE_LIMIT } from "./schema.js";
import {
  backOfficeProjectContext,
  readableBackOfficeRecord,
  type BackOfficeRecord,
} from "./schema.js";
import { randomUUID } from "node:crypto";
import {
  backOfficePlatform,
  syncBackOffice,
  scheduleBackOfficeSync,
  previewBackOfficePublish,
  publishBackOffice,
} from "./sync.js";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  addRoute,
  type Route,
  type RequestContext,
} from "../routes/registry.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { backOfficeStore, type BackOfficeStore } from "./store.js";
import { backOfficeAccess } from "./access.js";
import { previewImport, applyImport } from "./import.js";
import { announceSyncChange } from "../app-sync-events.js";
import {
  localBackOfficeHistoryPage,
  localBackOfficeHistoryExport,
  platformBackOfficeHistory,
} from "./history.js";
import { BackOfficeHistoryTargetSchema } from "./schema.js";
import {
  BackOfficeAuditHeadSchema,
  BackOfficeHistoryExportSchema,
} from "./schema.js";
import { verifyBackOfficeHistoryExport } from "./history-export.js";

export function registerBackOfficeRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (
    request: Request,
    maxBytes: number,
  ) => Promise<Record<string, unknown>>;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  ensureWritable: (config: ServerConfig) => void;
  resolveWorkspace: (
    config: ServerConfig,
    id: string,
  ) => Promise<WorkspaceInfo>;
}) {
  const input = (ctx: RequestContext) =>
    options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024);
  const route = (
    method: string,
    path: string,
    action: (
      ctx: RequestContext,
      store: BackOfficeStore,
      access: Awaited<ReturnType<typeof backOfficeAccess>>,
    ) => Promise<unknown>,
  ) => {
    addRoute(
      options.routes,
      method,
      "/back-office" + path,
      "client",
      async (ctx) => {
        options.requireClientScope(
          ctx,
          method === "GET" ? "viewer" : "collaborator",
        );
        if (method !== "GET") options.ensureWritable(options.config);
        const access = await backOfficeAccess(
          options.config,
          ctx.url.searchParams.get("scope") === "team"
            ? true
            : ctx.url.searchParams.get("scope") === "local"
              ? false
              : undefined,
        );
        if (ctx.request.headers.get("x-legalwork-agent"))
          access.actor = { ...access.actor, agentId: "back-office" };
        try {
          const store = await backOfficeStore(options.config);
          store.checkIntegrity();
          store.requireAccount(access.scope, access.actor);
          store.restrictTeamAccess(access.scope, access.actor);
          if (
            access.scope !== "local" &&
            method !== "GET" &&
            !["/sync/preview", "/sync/publish", "/sync"].includes(path) &&
            !store.syncState(access.scope).enabled
          )
            throw new ApiError(
              403,
              "back_office_sync",
              "Open the team directory and reconnect before changing team records.",
            );
          const result = await action(ctx, store, access);
          store.requireAccount(access.scope, access.actor);
          store.checkIntegrity();
          if (method !== "GET") {
            announceSyncChange(options.config, "backOffice");
            if (access.scope !== "local")
              scheduleBackOfficeSync(options.config);
          }
          return result instanceof Response
            ? result
            : options.jsonResponse(result);
        } catch (error) {
          if (error instanceof z.ZodError)
            throw new ApiError(
              400,
              "back_office_input",
              "Check the Back Office input.",
              {
                issues: error.issues.map((issue) => ({
                  path: issue.path,
                  message: issue.message,
                })),
              },
            );
          throw error;
        }
      },
    );
  };
  // Verifying an existing export remains available when the local database
  // cannot be opened. It does not read or mutate the Back Office store.
  addRoute(
    options.routes,
    "POST",
    "/back-office/history/verify",
    "client",
    async (ctx) => {
      options.requireClientScope(ctx, "viewer");
      try {
        const body = z
          .object({
            exported: BackOfficeHistoryExportSchema,
            trustedHeads: z.array(BackOfficeAuditHeadSchema).default([]),
          })
          .parse(
            await options.readJsonBodyLimited(ctx.request, 32 * 1024 * 1024),
          );
        return options.jsonResponse(
          verifyBackOfficeHistoryExport(body.exported, body.trustedHeads),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          400,
          "back_office_history_verification",
          "The history export failed verification.",
          {
            reason:
              error instanceof z.ZodError
                ? "The export format is invalid."
                : error instanceof Error
                  ? error.message
                  : "The signature or proof chain is invalid.",
          },
        );
      }
    },
  );
  route("GET", "", async (_ctx, store, { scope, actor }) => {
    if (scope !== "local") {
      store.setSync(scope, true);
      await syncBackOffice(options.config);
      const refreshed = await backOfficeAccess(options.config, true);
      if (refreshed.actor.principalKey !== actor.principalKey)
        throw new ApiError(409, "back_office_account_changed", "The connected account changed. Refresh Back Office before continuing.");
      Object.assign(actor, refreshed.actor);
    }
    return {
      scope,
      model: store.model(scope),
      permissions: actor,
      views: store.views(scope),
      sync: store.syncState(scope, actor),
      records: store.records(scope, actor),
    };
  });
  route("GET", "/records/:object", async (ctx, store, { scope, actor }) => ({
    records: store.records(
      scope,
      actor,
      ctx.params.object,
      ctx.url.searchParams.get("archived") === "true",
    ),
  }));
  route(
    "POST",
    "/records/:id/files/:field",
    async (ctx, store, { scope, actor }) => {
      const body = z
        .union([
          z.object({
            objectId: z.string().optional(),
            name: z.string(),
            dataBase64: z
              .string()
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
              ),
          }),
          z.object({
            objectId: z.string().optional(),
            source: z.object({
              workspaceId: z.string(),
              path: projectFilePath,
            }),
          }),
        ])
        .parse(
          await options.readJsonBodyLimited(
            ctx.request,
            Math.ceil((BACK_OFFICE_FILE_LIMIT * 4) / 3) + 4096,
          ),
        );
      fileField(
        store,
        scope,
        actor,
        ctx.params.id,
        ctx.params.field,
        true,
        body.objectId,
      );
      let name: string, bytes: Uint8Array;
      if ("source" in body) {
        const workspace = await options.resolveWorkspace(
          options.config,
          body.source.workspaceId,
        );
        const root = await realpath(workspace.path);
        const path = await realpath(join(root, body.source.path));
        const inside = relative(root, path);
        if (
          isAbsolute(body.source.path) ||
          isAbsolute(inside) ||
          inside === ".." ||
          inside.startsWith(`..${sep}`)
        )
          throw new ApiError(
            403,
            "back_office_file",
            "Choose a file inside an accessible project.",
          );
        const info = await stat(path);
        if (!info.isFile() || info.size > BACK_OFFICE_FILE_LIMIT)
          throw new ApiError(
            413,
            "back_office_file_size",
            "Choose a file up to 10 MB.",
          );
        name = basename(path);
        bytes = await readFile(path);
      } else {
        name = body.name;
        bytes = Buffer.from(body.dataBase64, "base64");
      }
      return {
        file: await attachFile(
          options.config,
          store,
          scope,
          actor,
          ctx.params.id,
          ctx.params.field,
          name,
          bytes,
          body.objectId,
        ),
      };
    },
  );
  route(
    "GET",
    "/records/:id/files/:field/:file",
    async (ctx, store, { scope, actor }) => {
      const file = attachedFile(
        store,
        scope,
        actor,
        ctx.params.id,
        ctx.params.field,
        ctx.params.file,
      );
      const bytes = await loadAttachedFile(options.config, scope, file, actor.principalKey);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.size),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );
  route("POST", "/records", async (ctx, store, { scope, actor }) => ({
    record: store.saveRecord(scope, actor, await input(ctx)),
  }));
  route(
    "POST",
    "/projects/:id/matter",
    async (ctx, store, { scope, actor }) => {
      const workspace = await options.resolveWorkspace(
        options.config,
        ctx.params.id,
      );
      const body = z
        .object({
          name: z.string().trim().min(1).max(500),
          clients: z.array(z.string().uuid()).default([]),
        })
        .parse(await input(ctx));
      return store.transaction(() => {
        const matter = store.saveRecord(scope, actor, {
          objectId: "matters",
          revision: 0,
          values: { name: body.name, clients: body.clients },
        });
        const link = store.saveRecord(scope, actor, {
          objectId: "projectLinks",
          revision: 0,
          values: {
            name: workspace.name,
            projectId: workspace.id,
            matter: matter.id,
          },
        });
        return { matter, link };
      });
    },
  );
  route("POST", "/model/preview", async (ctx, store, { scope, actor }) => {
    const body = await input(ctx);
    return store.previewModel(
      scope,
      actor,
      body.model,
      z.number().int().nonnegative().parse(body.revision),
    );
  });
  route("PUT", "/model", async (ctx, store, { scope, actor }) => {
    const body = await input(ctx),
      revision = z.number().int().nonnegative().parse(body.revision);
    if (scope === "local")
      return { model: store.saveModel(scope, actor, body.model, revision) };
    if (!actor.model)
      throw new ApiError(
        403,
        "back_office_model",
        "Model administrator permission is required.",
      );
    store.requireAccount(scope, actor);
    const snapshot = await backOfficePlatform(options.config, [
      {
        id: randomUUID(),
        kind: "model",
        baseRevision: revision,
        schemaRevision: revision,
        data: body.model,
      },
    ], actor.principalKey);
    const replicaId = store.receive(scope, snapshot, actor);
    if (replicaId) actor.replicaId = replicaId;
    if (snapshot.conflicts.length)
      throw new ApiError(
        409,
        "back_office_model",
        snapshot.conflicts[0].message,
      );
    return { model: snapshot.model };
  });
  route("POST", "/views", async (ctx, store, { scope, actor }) => ({
    view: store.saveView(scope, actor, await input(ctx)),
  }));
  route("GET", "/audit/:id", async (ctx, store, { scope, actor }) => ({
    history: store.history(scope, actor, ctx.params.id),
  }));
  route("GET", "/history/:type/:id", async (ctx, store, { scope, actor }) => {
    const target = BackOfficeHistoryTargetSchema.parse({
      type: ctx.params.type,
      id: ctx.params.id,
    });
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(ctx.url.searchParams.get("limit") ?? 50);
    const cursor = z
      .string()
      .uuid()
      .nullable()
      .parse(ctx.url.searchParams.get("cursor"));
    if (scope !== "local")
      return platformBackOfficeHistory(options.config, store, scope, target, {
        limit,
        cursor,
        export: false,
      }, actor.principalKey);
    return localBackOfficeHistoryPage(
      store,
      scope,
      actor,
      target,
      limit,
      cursor,
    );
  });
  route(
    "GET",
    "/history/:type/:id/export",
    async (ctx, store, { scope, actor }) => {
      const target = BackOfficeHistoryTargetSchema.parse({
        type: ctx.params.type,
        id: ctx.params.id,
      });
      return scope === "local"
        ? localBackOfficeHistoryExport(store, scope, actor, target)
        : platformBackOfficeHistory(options.config, store, scope, target, {
            limit: 50,
            cursor: null,
            export: true,
          }, actor.principalKey);
    },
  );
  route("POST", "/import/preview", async (ctx, store, { scope, actor }) => {
    const body = z
      .object({
        objectId: z.string(),
        csv: z.string().max(1_000_000),
        mapping: z.record(z.string(), z.string()),
      })
      .parse(await input(ctx));
    return previewImport(
      store,
      scope,
      actor,
      body.objectId,
      body.csv,
      body.mapping,
    );
  });
  route("POST", "/import/apply", async (ctx, store, { scope, actor }) => ({
    records: applyImport(
      store,
      scope,
      actor,
      z
        .string()
        .uuid()
        .parse((await input(ctx)).planId),
    ),
  }));
  route("GET", "/sync/pending", async (_ctx, store, { scope, actor }) => {
    let current: BackOfficeRecord[] = [];
    try {
      current = (await backOfficePlatform(options.config, [], actor.principalKey)).records;
    } catch {
      /* Keep local proposals readable while offline. */
    }
    const model = store.model(scope),
      records = store.records(scope, actor);
    return {
      changes: store.pending(scope, 100, actor).map((entry) => {
        if (entry.change.kind !== "record")
          return {
            id: entry.change.id,
            error: entry.error,
            summary:
              entry.change.kind === "model"
                ? "Data model update"
                : "Saved view update",
            currentRevision: null,
            comparison: [],
          };
        const intent = store.queuedRecordIntent(scope, entry.change.id, actor),
          object = model.objects.find(
            (object) => object.id === intent.record.objectId,
          );
        if (!object)
          return {
            id: entry.change.id,
            error: entry.error,
            summary: "Record update",
            currentRevision: null,
            comparison: [],
          };
        const proposed = readableBackOfficeRecord(intent.record, object, actor),
          remote = current.find((record) => record.id === proposed.id);
        const display = (value: unknown, fieldId: string) => {
          if (fieldId === "projectId")
            return (
              options.config.workspaces.find(
                (workspace) => workspace.id === value,
              )?.name ?? "Linked project"
            );
          if (
            object.fields.find((field) => field.id === fieldId)?.type ===
            "relation"
          )
            return (Array.isArray(value) ? value : [value])
              .filter(Boolean)
              .map(
                (id) =>
                  records.find((record) => record.id === id)?.values.name ??
                  "Related record",
              )
              .join(", ");
          return value === undefined || value === null
            ? "Empty"
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
        };
        return {
          id: entry.change.id,
          error: entry.error,
          summary:
            proposed.objectId === "projectLinks"
              ? "Matter and project relationship"
              : String(proposed.values.name ?? object.label),
          currentRevision: remote?.revision ?? null,
          comparison: intent.fields
            .filter((id) => Object.hasOwn(proposed.values, id))
            .map((id) => ({
              field:
                object.fields.find((field) => field.id === id)?.label ??
                "Field",
              proposed: display(proposed.values[id], id),
              current: remote ? display(remote.values[id], id) : null,
            })),
        };
      }),
    };
  });
  route("POST", "/sync/resolve", async (ctx, store, { scope, actor }) => {
    if (!actor.edit)
      throw new ApiError(
        403,
        "back_office_forbidden",
        "Directory editor permission is required.",
      );
    const body = z
      .object({
        id: z.string().uuid(),
        revision: z.number().int().nonnegative(),
      })
      .parse(await input(ctx));
    const intent = store.queuedRecordIntent(scope, body.id, actor),
      before = await backOfficePlatform(options.config, [], actor.principalKey),
      current = before.records.find((record) => record.id === intent.record.id);
    if (!current || current.revision !== body.revision)
      throw new ApiError(
        409,
        "back_office_conflict",
        "The team record changed. Review the comparison again.",
      );
    const data = {
      ...current,
      values: {
        ...current.values,
        ...Object.fromEntries(
          intent.fields.map((id) => [id, intent.record.values[id] ?? null]),
        ),
      },
      archivedAt: intent.metadata.includes("archive") ? intent.record.archivedAt : current.archivedAt,
      sourceId: intent.metadata.includes("sourceId") ? intent.record.sourceId : current.sourceId,
      access: intent.metadata.includes("sharing") ? intent.record.access : current.access,
      members: intent.metadata.includes("sharing") ? intent.record.members : current.members,
    };
    store.requireAccount(scope, actor);
    const operationId = randomUUID(),
      snapshot = await backOfficePlatform(options.config, [
        {
          id: operationId,
          kind: "record",
          baseRevision: current.revision,
          schemaRevision: before.model.revision,
          data,
          changedFields: intent.fields,
          changedMetadata: intent.metadata,
        },
      ], actor.principalKey);
    if (!snapshot.accepted.includes(operationId))
      throw new ApiError(
        409,
        "back_office_conflict",
        snapshot.conflicts[0]?.message ??
          "The team record could not be updated.",
      );
    store.discardQueued(scope, body.id, actor);
    const replicaId = store.receive(scope, snapshot, actor);
    if (replicaId) actor.replicaId = replicaId;
    return { ok: true };
  });
  route("POST", "/sync/discard", async (ctx, store, { scope, actor }) => {
    store.discardQueued(
      scope,
      z
        .string()
        .uuid()
        .parse((await input(ctx)).id),
      actor,
    );
    await syncBackOffice(options.config);
    return { ok: true };
  });
  route("POST", "/sync/preview", async () =>
    previewBackOfficePublish(options.config),
  );
  route("POST", "/sync/publish", async (ctx) =>
    publishBackOffice(
      options.config,
      z
        .string()
        .uuid()
        .parse((await input(ctx)).planId),
    ),
  );
  route("POST", "/sync", async (_ctx, store, { scope, actor }) => {
    await syncBackOffice(options.config);
    return store.syncState(scope, actor);
  });
  route("GET", "/projects", async () => ({
    projects: options.config.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
    })),
  }));
  addRoute(
    options.routes,
    "GET",
    "/workspace/:id/back-office/context",
    "client",
    async (ctx) => {
      options.requireClientScope(ctx, "viewer");
      await options.resolveWorkspace(options.config, ctx.params.id);
      const { scope, actor } = await backOfficeAccess(
          options.config,
          ctx.url.searchParams.get("scope") === "team"
            ? true
            : ctx.url.searchParams.get("scope") === "local"
              ? false
              : undefined,
        ),
        store = await backOfficeStore(options.config);
      return options.jsonResponse(
        backOfficeProjectContext(store.records(scope, actor), ctx.params.id),
      );
    },
  );
}
