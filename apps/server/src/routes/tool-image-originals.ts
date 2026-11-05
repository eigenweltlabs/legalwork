import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ApiError, findApiError } from "../errors.js";
import { canonicalFilePath, withFileWriteLock } from "../file-write-lock.js";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import { resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import { nativeHistoryImageSource } from "../session-history-images.js";
import { assertSessionImageTarget, requireSessionImageOrigin, recheckSessionImageOrigin } from "../session-image-authority.js";
import { assertOriginalImageCommitted, originalImageCaptureSource } from "../tool-image-original-access.js";
import { toolImageOriginalStore } from "../tool-image-original-store.js";
import { toolImageCaptureInput, toolImageOriginalListInput, toolImageOriginalReference, toolImageCropInput, toolImageExportInput } from "../tool-image-original-schema.js";
import type { ToolImageOriginalReference } from "../tool-image-original-schema.js";
import type { createToolImageRaster } from "../tool-image-raster.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { originalImageExportPath } from "../tool-image-original-path.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function withinProject(directory: string, path: string, allowRoot = false) {
  const root = await realpath(directory), actual = await canonicalFilePath(path), part = relative(root, actual);
  if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`) || !part && !allowRoot) throw new ApiError(403, "original_export_outside_project", "Original image exports must stay inside the current project.");
  return actual;
}

export function registerToolImageOriginalRoutes(options: {
  routes: Route[]; config: ServerConfig; raster: ReturnType<typeof createToolImageRaster>;
  jsonResponse: (value: unknown, status?: number) => Response;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
}) {
  const { routes, config, raster, jsonResponse, resolveWorkspace } = options, store = toolImageOriginalStore(config);
  const path = "/workspace/:id/sessions/:sessionId/tool-image-originals";
  async function access(ctx: RequestContext) {
    const origin = await requireSessionImageOrigin(config, ctx.request, ctx.params.sessionId), workspace = await resolveWorkspace(config, ctx.params.id);
    const affinity = config.managedImageAffinity?.(workspace), connection = resolveWorkspaceOpencodeConnection(config, workspace);
    const assertConnection = async () => {
      const latest = await resolveWorkspace(config, ctx.params.id);
      const current = resolveWorkspaceOpencodeConnection(config, latest);
      if (workspaceEngineLocation(latest).directory !== workspaceEngineLocation(workspace).directory || config.managedImageAffinity?.(latest) !== affinity || current.baseUrl !== connection.baseUrl || current.authHeader !== connection.authHeader)
        throw new ApiError(403, "original_image_connection_changed", "The engine connection changed while image access was pending.");
    };
    const source = nativeHistoryImageSource(createEngineClient(config, workspace));
    await assertSessionImageTarget(source, workspace, origin.sessionId, origin.sessionId, ctx.request.signal);
    await assertConnection();
    return { origin, workspace, source, affinity, assertConnection };
  }
  async function authorizedImage(ctx: RequestContext, reference: ToolImageOriginalReference) {
    const current = await access(ctx);
    await assertSessionImageTarget(current.source, current.workspace, current.origin.sessionId, reference.sessionID, ctx.request.signal);
    const image = await store.metadata(reference);
    if (image.source.storageNamespace !== (current.affinity?.storageNamespace ?? "unverified"))
      throw new ApiError(404, "tool_image_original_unavailable", "This original belongs to another engine history.");
    await assertOriginalImageCommitted(current.source, current.workspace, current.origin.sessionId, image, ctx.request.signal);
    await current.assertConnection();
    return { ...current, image };
  }
  addRoute(routes, "POST", `${path}/capture`, "client", async ctx => {
    const current = await access(ctx), form = await ctx.request.formData();
    const metadata = form.get("metadata"), file = form.get("image");
    let input: unknown;
    try { input = typeof metadata === "string" ? JSON.parse(metadata) : undefined; } catch { /* Safe schema error below. */ }
    const parsed = toolImageCaptureInput.safeParse(input);
    if (!parsed.success || !(file instanceof Blob)) throw new ApiError(400, "invalid_original_image_capture", "A native image observation and its exact bytes are required.");
    const captured = await originalImageCaptureSource(current.source, current.workspace, current.origin.sessionId, parsed.data, ctx.request.signal);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = await store.capture(current.origin.sessionId, parsed.data, bytes, { directory: captured.session.location.directory, projectID: captured.session.projectID,
      workspaceID: current.workspace.id, linkage: captured.linkage, storageNamespace: current.affinity?.storageNamespace ?? "unverified" }, ctx.request.signal, async () => {
      await originalImageCaptureSource(current.source, current.workspace, current.origin.sessionId, parsed.data, ctx.request.signal);
      await recheckSessionImageOrigin(config, ctx.request, current.origin);
      await current.assertConnection();
    });
    await recheckSessionImageOrigin(config, ctx.request, current.origin);
    await current.assertConnection();
    return jsonResponse({ image });
  });
  addRoute(routes, "GET", path, "client", async ctx => {
    const current = await access(ctx), parsed = toolImageOriginalListInput.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!parsed.success) throw new ApiError(400, "invalid_original_image_list", "Use a chat ID and its returned metadata cursor.");
    const targetID = parsed.data.sessionID ?? current.origin.sessionId;
    const target = await assertSessionImageTarget(current.source, current.workspace, current.origin.sessionId, targetID, ctx.request.signal);
    const page = await store.page(targetID, parsed.data.cursor), images = [];
    for (const image of page.images) {
      if (image.source.storageNamespace !== (current.affinity?.storageNamespace ?? "unverified")) continue;
      try { await assertOriginalImageCommitted(current.source, current.workspace, current.origin.sessionId, image, ctx.request.signal); images.push(image); }
      catch (error) { if (findApiError(error)?.status !== 404) throw error; }
    }
    let parent: { status: "none" | "unavailable" } | { status: "available"; sessionID: string } = { status: "none" };
    if (target.session.parentID) {
      parent = { status: "unavailable" };
      if (!target.visited.has(target.session.parentID)) {
        try { await assertSessionImageTarget(current.source, current.workspace, current.origin.sessionId, target.session.parentID, ctx.request.signal); parent = { status: "available", sessionID: target.session.parentID }; }
        catch (error) { if (findApiError(error)?.status !== 404) throw error; }
      }
    }
    await assertSessionImageTarget(current.source, current.workspace, current.origin.sessionId, targetID, ctx.request.signal);
    await recheckSessionImageOrigin(config, ctx.request, current.origin);
    await current.assertConnection();
    return jsonResponse({ sessionID: targetID, images, nextCursor: page.nextCursor, pageSize: 100, parent });
  });
  addRoute(routes, "POST", `${path}/read`, "client", async ctx => {
    const reference = toolImageOriginalReference.parse(await ctx.request.json()), current = await authorizedImage(ctx, reference);
    const { bytes } = await store.read(reference, ctx.request.signal);
    await assertOriginalImageCommitted(current.source, current.workspace, current.origin.sessionId, current.image, ctx.request.signal);
    await recheckSessionImageOrigin(config, ctx.request, current.origin);
    await current.assertConnection();
    return jsonResponse({ image: current.image, uri: `data:${current.image.mime};base64,${bytes.toString("base64")}` });
  });
  addRoute(routes, "POST", `${path}/crop`, "client", async ctx => {
    const input = toolImageCropInput.parse(await ctx.request.json()), current = await authorizedImage(ctx, input.reference);
    const { bytes } = await store.read(input.reference, ctx.request.signal);
    const cropped = await raster.crop({ bytes, mime: current.image.mime, rectangle: input.rectangle, signal: ctx.request.signal });
    await assertOriginalImageCommitted(current.source, current.workspace, current.origin.sessionId, current.image, ctx.request.signal);
    await recheckSessionImageOrigin(config, ctx.request, current.origin);
    await current.assertConnection();
    const { bytes: output, ...crop } = cropped;
    if (crop.originalSha256 !== current.image.reference.sha256) throw new Error("The raster worker processed another original image.");
    return jsonResponse({ image: current.image, crop, uri: `data:${cropped.mime};base64,${Buffer.from(output).toString("base64")}` });
  });
  addRoute(routes, "POST", `${path}/export`, "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const input = toolImageExportInput.parse(await ctx.request.json()), current = await authorizedImage(ctx, input.reference);
    const directory = workspaceEngineLocation(current.workspace).directory, destination = originalImageExportPath(directory, input.path);
    await withinProject(directory, destination);
    await options.requireApproval(ctx, { workspaceId: current.workspace.id, action: "workspace.file.write", paths: [destination], summary: `Export the exact original image to ${input.path}` });
    return withFileWriteLock(destination, async () => {
      const before = await lstat(destination).catch(error => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; });
      if (before && (!before.isFile() || before.isSymbolicLink())) throw new ApiError(400, "invalid_original_export_path", "Exports cannot replace directories or links.");
      if (before && !input.overwrite) throw new ApiError(409, "original_export_exists", "The file already exists. Choose another path or explicitly request overwrite.");
      const previousHash = before ? sha256(await readFile(destination)) : undefined;
      const { bytes } = await store.read(input.reference, ctx.request.signal);
      // Revalidate after approval/native reads and before creating directories.
      // A swapped ancestor must not cause even a rejected export to mutate an outside tree.
      await withinProject(directory, dirname(destination), true);
      await mkdir(dirname(destination), { recursive: true });
      const parent = await withinProject(directory, dirname(destination), true);
      const target = join(parent, destination.slice(dirname(destination).length + 1)), temporary = join(parent, `.original-export-${randomUUID()}`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, signal: ctx.request.signal });
        const file = await open(temporary, "r+"); try { await file.sync(); } finally { await file.close(); }
        await assertOriginalImageCommitted(current.source, current.workspace, current.origin.sessionId, current.image, ctx.request.signal);
        await recheckSessionImageOrigin(config, ctx.request, current.origin);
      await current.assertConnection(); await withinProject(directory, destination);
        const now = await lstat(destination).catch(error => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; });
        if (Boolean(now) !== Boolean(before) || now && (!now.isFile() || now.isSymbolicLink() || now.dev !== before?.dev || now.ino !== before.ino || sha256(await readFile(destination)) !== previousHash))
          throw new ApiError(409, "original_export_changed", "The export target changed while approval or image access was pending.");
        ctx.request.signal.throwIfAborted();
        if (input.overwrite) await rename(temporary, target);
        else await link(temporary, target).catch(error => { if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new ApiError(409, "original_export_exists", "A file appeared at the export path. It was not overwritten."); throw error; });
      } finally { await rm(temporary, { force: true }); }
      return jsonResponse({ image: current.image, path: input.path, bytes: bytes.byteLength, sha256: current.image.reference.sha256 });
    });
  });
}
