import { z } from "zod";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import {
  BackOfficeRecordSchema,
  BackOfficeFilesSchema,
  type BackOfficeFile,
  type BackOfficeChange,
} from "./schema.js";
import { cachedFile, cacheFile, historicalFile } from "./files.js";
import { backOfficeStore } from "./store.js";
import { backOfficeAccess } from "./access.js";
import type { BackOfficeActor } from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import { connectedBackOfficePrincipal, requireBackOfficePrincipal } from "./accounts.js";

async function fileRequest(config: ServerConfig, body: unknown, expectedPrincipal?: string) {
  const principal = expectedPrincipal ?? await connectedBackOfficePrincipal(config);
  if (!principal) throw new ApiError(403, "back_office_firm", "Sign in to your firm to open team attachments.");
  await ensureFreshPlatformToken(config);
  const client = requireIntakeClient(await requireBackOfficePrincipal(config, principal));
  const result = await intakeRequest(client, "POST", "/api/back-office/files", body);
  await requireBackOfficePrincipal(config, principal);
  return result;
}
export async function syncRecordFiles(
  config: ServerConfig,
  changes: BackOfficeChange[],
  expectedPrincipal?: string,
) {
  const { scope, actor } = await backOfficeAccess(config, true), store = await backOfficeStore(config);
  if (expectedPrincipal && actor.principalKey !== expectedPrincipal)
    throw new ApiError(409, "back_office_account_changed", "The connected account changed.");
  const sent = new Set<string>();
  for (const change of changes) {
    if (change.kind !== "record") continue;
    const record = BackOfficeRecordSchema.parse(change.data);
    for (const value of Object.values(record.values)) {
      const parsed = BackOfficeFilesSchema.safeParse(value);
      if (!parsed.success) continue;
      for (const file of parsed.data) {
        if (sent.has(file.id)) continue;
        sent.add(file.id);
        const prepared = z
          .object({ uploaded: z.boolean(), url: z.string().url().optional() })
          .parse(
            await fileRequest(config, {
              action: "prepare",
              objectId: record.objectId,
              file,
            }, expectedPrincipal),
          );
        if (prepared.uploaded) continue;
        const bytes = await cachedFile(config, file, store, scope, actor) ?? await cachedFile(config, file, store, "local", { userId: "local", edit: true, model: true, finance: true });
        if (!bytes || !prepared.url)
          throw new ApiError(
            409,
            "back_office_file",
            "This attachment is not available on this computer. Restore its saved copy before syncing.",
          );
        if (expectedPrincipal) await requireBackOfficePrincipal(config, expectedPrincipal);
        const uploaded = await fetch(prepared.url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
          },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(120_000),
        });
        await uploaded.body?.cancel();
        if (!uploaded.ok)
          throw new ApiError(
            502,
            "back_office_file",
            "The attachment upload failed. It will be retried.",
          );
        await fileRequest(config, { action: "commit", id: file.id }, expectedPrincipal);
      }
    }
  }
}
export async function loadAttachedFile(
  config: ServerConfig,
  scope: string,
  file: BackOfficeFile,
  expectedPrincipal?: string,
  context?: { store: BackOfficeStore; actor: BackOfficeActor; eventId?: string },
) {
  const store = context?.store ?? await backOfficeStore(config);
  const actor = context?.actor ?? (await backOfficeAccess(config, scope !== "local")).actor;
  store.requireAccount(scope, actor);
  if (expectedPrincipal) await requireBackOfficePrincipal(config, expectedPrincipal);
  // Team historical downloads must be authorized against the server's current policy first.
  const local = context?.eventId && scope !== "local" ? null : await cachedFile(config, file, store, scope, actor);
  if (local) {
    if (expectedPrincipal) await requireBackOfficePrincipal(config, expectedPrincipal);
    return local;
  }
  if (scope === "local")
    throw new ApiError(
      404,
      "back_office_file",
      "The attachment copy is missing from this computer.",
    );
  const { url } = z
    .object({ url: z.string().url() })
    .parse(
      await fileRequest(config, {
        action: "download",
        id: file.id,
        recordId: file.recordId,
        fieldId: file.fieldId,
        eventId: context?.eventId,
      }, expectedPrincipal),
    );
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(
      502,
      "back_office_file",
      "The attachment could not be downloaded.",
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader)
    throw new ApiError(
      502,
      "back_office_file",
      "The attachment download is empty.",
    );
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > file.size) {
      await reader.cancel();
      throw new ApiError(
        409,
        "back_office_file",
        "The downloaded file exceeds its saved size.",
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (expectedPrincipal) await requireBackOfficePrincipal(config, expectedPrincipal);
  store.requireAccount(scope, actor);
  if (context?.eventId && scope === "local") historicalFile(store, scope, actor, file.recordId, file.fieldId, file.id, context.eventId);
  await cacheFile(config, file, bytes, store, scope, actor);
  return bytes;
}
