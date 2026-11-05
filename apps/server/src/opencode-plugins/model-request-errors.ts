import { z } from "zod";

/** Provider adapters may treat HTTP 413 as token overflow and automatically
 * compact, losing the original transport error. A transport byte limit cannot be
 * repaired that way. Fail this request once with content-free measurements;
 * the engine persists this ordinary error and leaves the images untouched. */
export async function checkModelResponse(response: Response, requestBytes?: number) {
  if (response.status !== 413) return response;
  const body: unknown = await response.clone().json().catch(() => null);
  const parsed = z.object({ error: z.object({ code: z.string().optional(), max_request_bytes: z.number().int().positive().optional() }) }).safeParse(body);
  // A provider explicitly identifying token overflow still owns that decision.
  if (parsed.success && parsed.data.error.code === "context_length_exceeded") {
    return response;
  }
  const limit = parsed.success ? parsed.data.error.max_request_bytes : undefined;
  throw new Error(`request_too_large: HTTP 413${requestBytes === undefined ? "" : `; request_bytes=${requestBytes}`}${limit === undefined ? "" : `; max_request_bytes=${limit}`}. The provider rejected the request body before inference. Revert to before the image attachments or start a new chat with fewer attachments.`);
}
