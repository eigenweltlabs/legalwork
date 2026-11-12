import { changeNativeLinks, linkChangesSchema, nativeSources, sourceSchema, visibleNativeLinks } from "./native-links.js";
import { firstSyncStatus, assignLocalRecords, localDirectoryRows, editLocalCopy, createLocalRelated } from "./first-sync.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { BackOfficeQueryPageSchema } from "../views/schema.js";
import { queryDirectoryRecords } from "./dashboard-query.js";
import { projectFilePath } from "../project-file-schema.js";
import { projectBackOfficeReferences, projectReferenceDirectory } from "./project-references.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { attachFile, attachedFile, historicalFile, fileFromHistory, fileField } from "./files.js";
import { loadAttachedFile } from "./file-sync.js";
import { BACK_OFFICE_FILE_LIMIT } from "./schema.js";
import {
  readableBackOfficeRecord,
  type BackOfficeRecord,
} from "./schema.js";
import { createHash, randomUUID } from "node:crypto";
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
import { backOfficeAccess, refreshBackOfficeActor, backOfficeDirectoryIdentity as directoryIdentity } from "./access.js";
import { previewImport, applyImport } from "./import.js";
import { announceSyncChange } from "../app-sync-events.js";
import {
  localBackOfficeHistoryPage,
  localBackOfficeHistoryExport,
  platformBackOfficeHistory,
} from "./history.js";
import { BackOfficeValueSchema, BackOfficeHistoryTargetSchema } from "./schema.js";
import {
  BackOfficeAuditHeadSchema,
  BackOfficeHistoryExportSchema,
} from "./schema.js";
import { verifyBackOfficeHistoryExport } from "./history-export.js";
import { workspaceContentPath } from "../project-storage-paths.js";
import { readProjectDetails } from "../project-store.js";


function recordDigest(record: BackOfficeRecord) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

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
    readOnly = method === "GET",
  ) => {
    addRoute(
      options.routes,
      method,
      "/back-office" + path,
      "client",
      async (ctx) => {
        options.requireClientScope(
          ctx,
          readOnly ? "viewer" : "collaborator",
        );
        if (!readOnly) options.ensureWritable(options.config);
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
          const result = await action(ctx, store, access);
          store.requireAccount(access.scope, access.actor);
          store.checkIntegrity();
          if (!readOnly) {
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
  route("GET", "", async (ctx, store, { scope, actor }) => {
    if (scope !== "local" && ctx.url.searchParams.has("manifest")) {
      scheduleBackOfficeSync(options.config);
    } else if (scope !== "local") {
      await syncBackOffice(options.config);
      await refreshBackOfficeActor(options.config, scope, actor);
    }
    const metadata = {
      scope,
      directoryId: await directoryIdentity(options.config, scope, store),
      model: store.model(scope),
      permissions: actor,
      ...(scope !== "local" && actor.principalKey ? { firstSync: { ...firstSyncStatus(store, actor), firm: (await readEigenweltConnection(options.config)).account?.orgName ?? scope } } : {}),
      views: store.views(scope),
      sync: store.syncState(scope, actor),
    };
    if (ctx.url.searchParams.get("schema") === "1") return metadata;
    const archivedObject = ctx.url.searchParams.get("archivedObject") || undefined;
    const records = store.records(scope, actor, archivedObject, Boolean(archivedObject));
    const localObject = ctx.url.searchParams.get("pendingLocalObject");
    const local = localObject && (!archivedObject || archivedObject === localObject) && metadata.firstSync && (metadata.firstSync.unassigned || metadata.firstSync.waiting)
      ? localDirectoryRows(store, scope, actor, localObject, Boolean(archivedObject)) : {};
    if (ctx.url.searchParams.get("manifest") !== "1") return { ...metadata, ...local, records };
    const index = records.map(record => [record.id, recordDigest(record)]);
    const identity = JSON.stringify([archivedObject, metadata.directoryId, actor.userId, actor.principalKey, actor.replicaId, actor.finance, actor.model]);
    const version = createHash("sha256").update(identity).update(JSON.stringify(index)).digest("hex");
    return { ...metadata, version, ...local, index: ctx.url.searchParams.get("known") === version ? null : index };
  });
  route("POST", "/dashboard-query", async (ctx, store, { scope, actor }) => {
    const query = BackOfficeQueryPageSchema.parse(await input(ctx));
    if (query.directoryId !== await directoryIdentity(options.config, scope, store))
      throw new ApiError(409, "back_office_directory_changed", "Open this dashboard from its original Back Office directory.");
    if (scope !== "local") {
      await syncBackOffice(options.config);
      await refreshBackOfficeActor(options.config, scope, actor);
    }
    const model = store.model(scope);
    const result = queryDirectoryRecords(model, actor, (objectId) => {
      const active = store.records(scope, actor, objectId);
      return query.includeArchived ? active.concat(store.records(scope, actor, objectId, true)) : active;
    }, query);
    return result;
  }, true);
  route("GET", "/record-page", async (ctx, store, {scope, actor}) => {
    const ids = z.array(z.string().uuid()).min(1).max(100).parse(ctx.url.searchParams.get("ids")?.split(","));
    const directoryId = await directoryIdentity(options.config, scope, store);
    const model = store.model(scope);
    const archivedObject = ctx.url.searchParams.get("archivedObject");
    const rows = ids.flatMap(id => {
      const record = store.raw(scope, id);
      const object = record && model.objects.find(item => item.id === record.objectId);
      if (!record || !object || object.archived || !store.canRead(scope, record, actor)) return [];
      if (Boolean(record.archivedAt) !== Boolean(archivedObject) || (archivedObject && record.objectId !== archivedObject)) return [];
      const visible = readableBackOfficeRecord(record, object, actor);
      return [{ record: visible, digest: recordDigest(visible) }];
    });
    return { directoryId, permissions: actor, rows };
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
        const root = await realpath(workspaceContentPath(workspace));
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
      const eventId = z.string().uuid().nullable().parse(ctx.url.searchParams.get("eventId"));
      let file;
      if (eventId && scope !== "local") {
        const exported = BackOfficeHistoryExportSchema.parse(await platformBackOfficeHistory(options.config, store, scope, { type: "record", id: ctx.params.id }, { limit: 100, cursor: null, export: true }, actor.principalKey));
        file = fileFromHistory(exported.body.items, ctx.params.id, ctx.params.field, ctx.params.file, eventId);
        if (!file) throw new ApiError(404, "back_office_file", "This historical attachment is unavailable with your current access.");
      } else file = eventId ? historicalFile(store, scope, actor, ctx.params.id, ctx.params.field, ctx.params.file, eventId) : attachedFile(
        store,
        scope,
        actor,
        ctx.params.id,
        ctx.params.field,
        ctx.params.file,
      );
      const bytes = await loadAttachedFile(options.config, scope, file, actor.principalKey, { store, actor, ...(eventId ? { eventId } : {}) });
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
  route("POST", "/records", async (ctx, store, { scope, actor }) => {
    const { directoryId, expectedUserId, expectedPrincipalKey, expectedReplicaId, ...body } = await input(ctx);
    if ((expectedUserId !== undefined && actor.userId !== expectedUserId) ||
        (expectedPrincipalKey !== undefined && actor.principalKey !== expectedPrincipalKey) ||
        (directoryId !== undefined && directoryId !== await directoryIdentity(options.config, scope, store)))
      throw new ApiError(409, "back_office_directory_changed", "These changes could not be saved with the current account.");
    if (expectedReplicaId !== undefined && actor.replicaId !== expectedReplicaId)
      throw new ApiError(409, "back_office_replica_changed", "The directory is updating.");
    if (body.localSource !== undefined) {
      const source = z.object({ id: z.string().uuid(), objectId: z.string(), fields: z.array(z.string()).min(1).max(16) }).parse(body.localSource);
      return createLocalRelated(store, scope, actor, source, z.object({ id: z.string().uuid(), objectId: z.string(), values: z.record(z.string(), BackOfficeValueSchema) }).parse(body));
    }
    if (body.localCopy === true) return editLocalCopy(store, scope, actor, z.object({
      id: z.string().uuid(), objectId: z.string(), revision: z.number().int().positive(),
      values: z.record(z.string(), BackOfficeValueSchema), expectedValues: z.record(z.string(), BackOfficeValueSchema).optional(), archived: z.boolean().optional(),
    }).parse(body));
    return { record: store.saveRecord(scope, actor, body) };
  });
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
    await refreshBackOfficeActor(options.config, scope, actor);
    return { ok: true };
  });
  route("POST", "/sync/assign-local", async (ctx, store, { scope, actor }) => {
    const body = z.object({ directoryId: z.string(), selection: z.string().length(64) }).parse(await input(ctx));
    if (scope === "local" || body.directoryId !== await directoryIdentity(options.config, scope, store))
      throw new ApiError(409, "back_office_directory_changed", "These records could not be shared with the current firm.");
    assignLocalRecords(store, scope, actor, body.selection);
    await syncBackOffice(options.config);
    return { ok: true };
  });
  route("POST", "/sync/preview", async (_ctx, _store, { scope, actor }) => {
    const result = await previewBackOfficePublish(options.config);
    await refreshBackOfficeActor(options.config, scope, actor);
    return result;
  });
  route("POST", "/sync/publish", async (ctx, _store, { scope, actor }) => {
    const result = await publishBackOffice(
      options.config,
      z
        .string()
        .uuid()
        .parse((await input(ctx)).planId),
    );
    await refreshBackOfficeActor(options.config, scope, actor);
    return result;
  });
  route("POST", "/sync", async (_ctx, store, { scope, actor }) => {
    await syncBackOffice(options.config);
    await refreshBackOfficeActor(options.config, scope, actor);
    return store.syncState(scope, actor);
  });
  route("GET", "/native-linked/:id", async (ctx,store,access) => {
    const sources = await nativeSources(options.config);
    const links = visibleNativeLinks(store,access,sources,{recordId:ctx.params.id});
    return { links:links.map(edge => ({...edge,title:edge.kind === "task" ? sources.tasks.getTask(edge.sourceId)!.title : sources.calendars.get(edge.projectKey,edge.sourceId).title})) };
  });
  route("GET", "/native-links", async (ctx, store, access) => {
    const params = ctx.url.searchParams;
    const source = sourceSchema.parse(Object.fromEntries(params));
    if (params.get("directoryId") !== await directoryIdentity(options.config, access.scope, store) || params.get("userId") !== access.actor.userId)
      throw new ApiError(409, "native_link_account", "The account changed.");
    const sources = await nativeSources(options.config, source);
    if (!sources.allowed(source)) throw new ApiError(404, "native_link_missing", "This record is unavailable.");
    return { ids: visibleNativeLinks(store, access, sources, source).map(edge => edge.recordId) };
  });
  route("POST", "/native-links", async (ctx, store, access) => {
    const body = sourceSchema.extend(linkChangesSchema.shape).parse(await input(ctx));
    if (body.directoryId !== await directoryIdentity(options.config,access.scope,store) || body.userId !== access.actor.userId)
      throw new ApiError(409,"native_link_account","The account changed.");
    changeNativeLinks(store,access,await nativeSources(options.config, body),body,body.add,body.remove);
    return { saved:true };
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
      const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
      const details = await readProjectDetails(workspace.path);
      const team = ctx.url.searchParams.get("scope") === "team" ? true : ctx.url.searchParams.get("scope") === "local" ? false : undefined;
      return options.jsonResponse(projectBackOfficeReferences(await projectReferenceDirectory(options.config, team), details.fields));
    },
  );
}
