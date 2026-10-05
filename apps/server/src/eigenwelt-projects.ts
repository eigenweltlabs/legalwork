import type { ProjectRemote } from "@legalwork/types/workspace";
import { projectRemoteSchema } from "./project-schema.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

import { intakeRequest, type IntakeClient } from "./eigenwelt-intake.js";
import { ApiError } from "./errors.js";
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from "./runtime-opencode-config-store.js";
import { receiveFile } from "./file-storage/common.js";

/**
 * Client for the firm's synced projects (Akten) on the Eigenwelt platform:
 * the project records, and the documents they carry. Same credentials and
 * error mapping as the task client (eigenwelt-intake.ts). Documents move in
 * chunks keyed by the whole file's sha256 (which is also a document's
 * version), straight between this machine and the firm's storage over links
 * the platform signs; the platform itself never carries the bytes.
 */

/** One chunk of a file; the platform keeps chunks this size. */
export const PROJECT_CHUNK_BYTES = 8 * 1024 * 1024;
/** The largest document a project syncs; the platform refuses anything larger. */
export const PROJECT_MAX_FILE_BYTES = 256 * 1024 * 1024;

const scopeSchema = z.object({
  documents: z.boolean(),
  notes: z.boolean(),
  tasks: z.boolean(),
  recordings: z.boolean(),
  metadata: z.boolean(),
  // A platform from before reviews were part of the scope syncs none.
  reviews: z.boolean().default(false),
  calendar: z.boolean().default(true),
});

const fieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  labelSource: z.enum(["suggested", "custom"]).optional(),
  type: z.enum(["text", "number", "date", "select"]),
  value: z.union([z.string(), z.number(), z.null()]),
  options: z.array(z.string()).optional(),
});

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerUserId: z.string(),
  role: z.enum(["owner", "member"]),
  access: z.enum(["org", "members"]),
  memberIds: z.array(z.string()),
  scope: scopeSchema,
  fields: z.array(fieldSchema),
  // Absent on older services; null on projects that have not shared instructions yet.
  personalizationPrompt: z.string().max(MAX_CUSTOM_INSTRUCTIONS_LENGTH).nullable().optional(),
  remote: projectRemoteSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RemoteProject = z.infer<typeof projectSchema>;

const projectPageSchema = z.object({
  projects: z.array(projectSchema),
  nextCursor: z.string().nullable(),
  hidden: z.array(z.string()).optional(),
});

const fileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
  contentType: z.string(),
  updatedByUserId: z.string(),
  updatedAt: z.string(),
});
export type RemoteProjectFile = z.infer<typeof fileSchema>;

/** A 2xx body of the wrong shape came from the wrong responder: fail, never read it as empty. */
function parsed<T>(schema: z.ZodType<T>, json: unknown): T {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(502, "intake_bad_response", "The Eigenwelt service sent a response LegalWork could not read.");
  }
  return result.data;
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

// --- Projects -------------------------------------------------------------------

export async function listRemoteProjects(
  client: IntakeClient,
  params: { updatedSince?: string | null; cursor?: string | null },
): Promise<{ projects: RemoteProject[]; nextCursor: string | null; hidden: string[] }> {
  const query = new URLSearchParams();
  if (params.updatedSince) query.set("updatedSince", params.updatedSince);
  if (params.cursor) query.set("cursor", params.cursor);
  const search = query.toString();
  const page = parsed(projectPageSchema, await intakeRequest(client, "GET", `/api/projects${search ? `?${search}` : ""}`));
  return { projects: page.projects, nextCursor: page.nextCursor, hidden: page.hidden ?? [] };
}

export type RemoteProjectCreate = {
  personalizationPrompt?: string;
  remote?: ProjectRemote;
  id: string;
  name: string;
  fields: z.infer<typeof fieldSchema>[];
  scope: z.infer<typeof scopeSchema>;
  access: "org" | "members";
  memberIds: string[];
};

export async function createRemoteProject(client: IntakeClient, input: RemoteProjectCreate): Promise<RemoteProject> {
  // Older platform versions require this retired field. Never transmit a summary.
  const json = await intakeRequest(client, "POST", "/api/projects", { ...input, ...(input.remote ? { remote: { ...input.remote, context: "" } } : {}) });
  return parsed(z.object({ project: projectSchema }), json).project;
}

export type RemoteProjectPatch = {
  personalizationPrompt?: string;
  remote?: ProjectRemote;
  name?: string;
  fieldChanges?: { id: string; field: z.infer<typeof fieldSchema> | null }[];
  fieldOrder?: string[];
  changedAt?: string;
  access?: "org" | "members";
  memberIds?: string[];
  scope?: z.infer<typeof scopeSchema>;
};

export async function patchRemoteProject(
  client: IntakeClient,
  projectId: string,
  patch: RemoteProjectPatch,
): Promise<{ project: RemoteProject | null; applied: string[] }> {
  const json = await intakeRequest(client, "PATCH", base(projectId), { ...patch, ...(patch.remote ? { remote: { ...patch.remote, context: "" } } : {}) });
  return parsed(z.object({ project: projectSchema.nullable(), applied: z.array(z.string()) }), json);
}

/** The owner stops syncing the project; already stopped is fine. */
export async function deleteRemoteProject(client: IntakeClient, projectId: string): Promise<void> {
  await intakeRequest(client, "DELETE", base(projectId));
}

// --- Documents ------------------------------------------------------------------

/**
 * Every document of the project as the firm has it now, all pages, and the
 * number of its last file change as of the first page (null from a platform
 * that does not count them): from there, `listRemoteProjectChanges`.
 */
export async function listRemoteProjectFiles(
  client: IntakeClient,
  projectId: string,
): Promise<{ files: RemoteProjectFile[]; seq: number | null }> {
  const files: RemoteProjectFile[] = [];
  let cursor: string | null = null;
  let seq: number | null = null;
  const seen = new Set<string>();
  do {
    const path: string = `${base(projectId)}/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = parsed(
      z.object({ files: z.array(fileSchema), nextCursor: z.string().nullable(), seq: z.number().int().optional() }),
      await intakeRequest(client, "GET", path),
    );
    if (cursor === null) seq = page.seq ?? null;
    files.push(...page.files);
    cursor = page.nextCursor;
    if (cursor !== null && seen.has(cursor)) throw new ApiError(502, "intake_bad_response", "The document list repeated a page.");
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return { files, seq };
}

export type RemoteProjectChanges = { reset: boolean; files: RemoteProjectFile[]; removed: string[]; seq: number };

/**
 * What changed in the project's documents since change `since`: written
 * (as they are now) and removed, all pages, and the number to ask from next.
 * `reset`: what the project carries changed; list everything again.
 */
export async function listRemoteProjectChanges(client: IntakeClient, projectId: string, since: number): Promise<RemoteProjectChanges> {
  const files: RemoteProjectFile[] = [];
  const removed: string[] = [];
  const pageSchema = z.object({
    reset: z.boolean(),
    files: z.array(fileSchema),
    removed: z.array(z.object({ path: z.string() })),
    seq: z.number().int(),
    more: z.boolean(),
  });
  for (let from = since; ; ) {
    const page = parsed(pageSchema, await intakeRequest(client, "GET", `${base(projectId)}/files?since=${from}`));
    if (page.reset) return { reset: true, files: [], removed: [], seq: page.seq };
    files.push(...page.files);
    removed.push(...page.removed.map((entry) => entry.path));
    if (!page.more) return { reset: false, files, removed, seq: page.seq };
    if (page.seq <= from) throw new ApiError(502, "intake_bad_response", "The list of changes did not move on.");
    from = page.seq;
  }
}

/**
 * A request to the firm's storage over a link the platform signed. No
 * credentials go along: the link is the permission, for one object, briefly.
 */
async function storageFetch(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error" });
  } catch {
    throw new ApiError(502, "project_storage_unreachable", "Could not reach the firm's file storage.");
  }
  if (!response.ok) {
    throw new ApiError(502, "project_storage_failed", `The firm's file storage answered ${response.status}.`);
  }
  return response;
}

/** The objects behind these links, one after another, as one stream. */
function joinedChunks(links: string[]): ReadableStream<Uint8Array> {
  let next = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (current === null) {
          const link = links[next++];
          if (link === undefined) {
            controller.close();
            return;
          }
          const body = (await storageFetch(link, { method: "GET" })).body;
          if (!body) throw new ApiError(502, "project_storage_failed", "A document chunk arrived without content.");
          current = body.getReader();
        }
        const read = await current.read();
        if (!read.done) {
          controller.enqueue(read.value);
          return;
        }
        current = null;
      }
    },
    async cancel(reason) {
      await current?.cancel(reason);
    },
  });
}

/**
 * Fetch one document into `destination` (a new file), chunk by chunk from the
 * firm's storage; answers what arrived, for the caller to check against the
 * version it expects.
 */
export async function downloadRemoteProjectFile(
  client: IntakeClient,
  projectId: string,
  path: string,
  destination: string,
): Promise<{ size: number; sha256: string }> {
  const content = parsed(
    z.object({ sha256: z.string(), size: z.number(), chunks: z.array(z.string()) }),
    await intakeRequest(client, "GET", `${base(projectId)}/files/content?path=${encodeURIComponent(path)}`),
  );
  return receiveFile(joinedChunks(content.chunks), destination);
}

/** The sha256 and size of a file on disk or in memory, read as a stream. */
export async function hashSource(source: Buffer | string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  if (typeof source !== "string") return { sha256: hash.update(source).digest("hex"), size: source.byteLength };
  let size = 0;
  for await (const chunk of createReadStream(source)) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), size };
}

/** One chunk of a file, copied into its own buffer for the request body. */
async function readRange(source: Buffer | string, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof source !== "string") return new Uint8Array(source.subarray(offset, offset + length));
  const handle = await open(source, "r");
  try {
    const bytes = new Uint8Array(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    return bytes.slice(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Why the platform refused with a 409 ("changed", "incomplete"), or null for anything else. */
function conflictReason(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("reason" in details)) return "changed";
  return typeof details.reason === "string" ? details.reason : "changed";
}

/**
 * Upload the chunks the platform lacks of a file straight to the firm's
 * storage, confirming each. Links come a few at a time and last minutes, so
 * this asks again until none are left. The platform checks each chunk's
 * size, not the hash; so the file is hashed again afterwards, and one that
 * changed while it was read is not committed under a hash its content does
 * not have.
 */
async function uploadChunks(
  client: IntakeClient,
  projectId: string,
  source: Buffer | string,
  sha256: string,
  size: number,
): Promise<void> {
  // Every round confirms at least one chunk, or fails.
  for (let round = 0; ; round++) {
    const { uploads } = parsed(
      z.object({ uploads: z.array(z.object({ index: z.number(), url: z.string() })) }),
      await intakeRequest(client, "POST", `${base(projectId)}/blobs/${sha256}`, { size }),
    );
    if (uploads.length === 0) break;
    if (round > Math.ceil(size / PROJECT_CHUNK_BYTES)) {
      throw new ApiError(502, "intake_bad_response", "The Eigenwelt service kept asking for the same chunks.");
    }
    for (const { index, url } of uploads) {
      const bytes = await readRange(source, index * PROJECT_CHUNK_BYTES, PROJECT_CHUNK_BYTES);
      await storageFetch(url, { method: "PUT", body: bytes });
      await intakeRequest(client, "POST", `${base(projectId)}/blobs/${sha256}/${index}`, { size });
    }
  }
  if ((await hashSource(source)).sha256 !== sha256) {
    throw new ApiError(409, "project_file_changed", "The file changed while it was uploaded; it is sent again.");
  }
}

/**
 * Put one document in place on the platform, replacing the version `ifMatch`
 * names (null: there must be none). The content goes up only when the
 * platform does not have it yet — a renamed or copied file costs nothing —
 * and only the chunks it lacks, so an interrupted upload resumes. A newer
 * version there is a 409 `storage_conflict` for the caller to settle. A
 * Tabular Review names the documents it reviews (`reviewSources`): with
 * reviews shared and documents not, the platform takes just those.
 */
export async function uploadRemoteProjectFile(
  client: IntakeClient,
  projectId: string,
  path: string,
  source: Buffer | string,
  contentType: string,
  ifMatch: string | null,
  reviewSources?: string[],
): Promise<RemoteProjectFile> {
  const { sha256, size } = await hashSource(source);
  if (size > PROJECT_MAX_FILE_BYTES) {
    throw new ApiError(413, "project_file_too_large", "This file is larger than 256 MiB and does not sync.");
  }
  const commit = async () =>
    parsed(
      z.object({ file: fileSchema }),
      await intakeRequest(client, "POST", `${base(projectId)}/files`, {
        path, sha256, size, contentType, ifMatch, ...(reviewSources === undefined ? {} : { reviewSources }),
      }),
    ).file;
  for (let attempt = 0; ; attempt++) {
    try {
      return await commit();
    } catch (error) {
      const reason = conflictReason(error);
      if (reason === null) throw error;
      if (reason !== "incomplete" || attempt > 0) {
        throw new ApiError(409, "storage_conflict", "The file changed on the firm's side since it was last synced.");
      }
      await uploadChunks(client, projectId, source, sha256, size);
    }
  }
}

/** Remove one document — only the version this machine saw; a newer one is a 409 `storage_conflict`. */
export async function deleteRemoteProjectFile(
  client: IntakeClient,
  projectId: string,
  path: string,
  ifMatch: string,
): Promise<void> {
  try {
    await intakeRequest(
      client,
      "DELETE",
      `${base(projectId)}/files?path=${encodeURIComponent(path)}&ifMatch=${encodeURIComponent(ifMatch)}`,
    );
  } catch (error) {
    if (conflictReason(error) === null) throw error;
    throw new ApiError(409, "storage_conflict", "The file changed on the firm's side since it was last synced.");
  }
}
