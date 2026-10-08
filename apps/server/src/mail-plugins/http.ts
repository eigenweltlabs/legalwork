import { z } from "zod";
import { ApiError } from "../errors.js";

export async function mailJson<T>(url: string | URL, schema: z.ZodType<T>, init: RequestInit = {}, maxBytes = 2 * 1024 * 1024): Promise<T> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  if (!response.ok) {
    await response.body?.cancel();
    const code = response.status === 401 ? "mail_reconnect_required" : response.status === 403 ? "mail_access_denied" : "mail_provider_failed";
    throw new ApiError(response.status === 401 || response.status === 403 ? response.status : 502, code,
      response.status === 401 ? "Reconnect this email account in Plugins settings." : response.status === 403 ? "The email provider denied this operation. Check account permissions or ask your administrator." : "The email provider could not complete this operation. Try again later.");
  }
  if (response.status === 202 || response.status === 204) return schema.parse(null);
  if (!response.body) throw new ApiError(502, "mail_invalid_response", "The email provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ApiError(413, "mail_response_too_large", "This email or attachment exceeds the plugin's size limit.");
      chunks.push(value);
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new ApiError(502, "mail_invalid_response", "The email provider returned an unexpected response.");
    return parsed.data;
  } finally { await reader.cancel().catch(() => undefined); }
}
