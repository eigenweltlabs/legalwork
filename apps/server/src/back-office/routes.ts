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
          if (method !== "GET") {
            announceSyncChange(options.config, "backOffice");
            if (access.scope !== "local")
              scheduleBackOfficeSync(options.config);
          }
          return options.jsonResponse(result);
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
  route("GET", "", async (_ctx, store, { scope, actor }) => {
    if (scope !== "local") {
      store.setSync(scope, true);
      await syncBackOffice(options.config);
    }
    return {
      scope,
      model: store.model(scope),
      permissions: actor,
      views: store.views(scope),
      sync: store.syncState(scope),
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
    const snapshot = await backOfficePlatform(options.config, [
      {
        id: randomUUID(),
        kind: "model",
        baseRevision: revision,
        schemaRevision: revision,
        data: body.model,
      },
    ]);
    store.receive(scope, snapshot);
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
      current = (await backOfficePlatform(options.config)).records;
    } catch {
      /* Keep local proposals readable while offline. */
    }
    const model = store.model(scope),
      records = store.records(scope, actor);
    return {
      changes: store.pending(scope).map((entry) => {
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
        const intent = store.queuedRecordIntent(scope, entry.change.id),
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
    const intent = store.queuedRecordIntent(scope, body.id),
      before = await backOfficePlatform(options.config),
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
      archivedAt: intent.record.archivedAt,
    };
    const operationId = randomUUID(),
      snapshot = await backOfficePlatform(options.config, [
        {
          id: operationId,
          kind: "record",
          baseRevision: current.revision,
          schemaRevision: before.model.revision,
          data,
          changedFields: intent.fields,
        },
      ]);
    if (!snapshot.accepted.includes(operationId))
      throw new ApiError(
        409,
        "back_office_conflict",
        snapshot.conflicts[0]?.message ??
          "The team record could not be updated.",
      );
    store.discardQueued(scope, body.id);
    store.receive(scope, snapshot);
    return { ok: true };
  });
  route("POST", "/sync/discard", async (ctx, store, { scope }) => {
    store.discardQueued(
      scope,
      z
        .string()
        .uuid()
        .parse((await input(ctx)).id),
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
  route("POST", "/sync", async (_ctx, store, { scope }) => {
    await syncBackOffice(options.config);
    return store.syncState(scope);
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
