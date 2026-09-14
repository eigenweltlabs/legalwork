import { z } from "zod";
import { open } from "node:fs/promises";
import { ApiError } from "../../errors.js";
import { conflict, sourceSize } from "../common.js";
import type { AccessToken } from "./providers.js";

export async function checkResponse(response: Response) {
  if (response.ok) return response;
  await response.body?.cancel();
  if (response.status === 409 || response.status === 412) conflict();
  if (response.status === 404) throw new ApiError(404, "storage_not_found", "This file or folder is no longer available.");
  if (response.status === 401) throw new ApiError(401, "storage_signin_required", "Sign in again in File storage settings.");
  if (response.status === 403) throw new ApiError(403, "storage_access_denied", "Your account does not have permission for this operation.");
  if (response.status === 429) throw new ApiError(429, "storage_rate_limited", "This connection is busy. Please try again shortly.");
  throw new ApiError(502, "storage_unavailable", "The file service could not complete this request. Please try again.");
}
export async function authorizedFetch(token: AccessToken, url: string | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await token()}`);
  return checkResponse(await fetch(url, { ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(120_000) }));
}
export async function jsonResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  await checkResponse(response);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new ApiError(502, "storage_invalid_response", "The file service returned an unexpected response.");
  return parsed.data;
}
/** Bounded memory for uploads, including files larger than the inline API limit. */
export async function* chunks(source: Buffer | string, size = 8 * 1024 * 1024): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(source)) {
    for (let offset = 0; offset < source.length; offset += size) yield source.subarray(offset, offset + size);
    return;
  }
  const file = await open(source, "r");
  try {
    const buffer = Buffer.alloc(size);
    while (true) {
      const result = await file.read(buffer, 0, size, null);
      if (!result.bytesRead) return;
      yield buffer.subarray(0, result.bytesRead);
    }
  } finally { await file.close(); }
}
export { sourceSize };
