import { ApiError, findApiError } from "./errors.js";

/** A queue-delivery endpoint explicitly refused this request before admission.
 * Transport failures and server failures do not establish non-acceptance. */
export class NativeDeliveryRejected extends ApiError {
  readonly accepted = false;
}

function message(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object" || depth > 3) return;
  if ("message" in value && typeof value.message === "string" && value.message.trim()) return value.message;
  for (const key of ["error", "detail", "data"]) {
    const nested = Reflect.get(value, key);
    const found = message(nested, depth + 1);
    if (found) return found;
  }
}

export function nativeResponseError(status: number, detail: unknown): ApiError {
  return new ApiError([400, 404, 409, 413, 422].includes(status) ? status : 502, "opencode_request_failed",
    message(detail) ?? "The agent engine rejected the request.", { status, detail });
}

/** Call only around native queued prompt admission, never around execution. */
export function nativeDeliveryRejection(error: unknown): NativeDeliveryRejected | undefined {
  const api = findApiError(error);
  if (!api) return;
  const status = api.details && typeof api.details === "object" && "status" in api.details && typeof api.details.status === "number"
    ? api.details.status : api.status;
  if (![400, 401, 403, 404, 409, 413, 422].includes(status)) return;
  const rejected = new NativeDeliveryRejected(api.status, api.code, api.message, api.details);
  rejected.cause = error;
  return rejected;
}

export function isNativeDeliveryRejected(error: unknown): boolean {
  return findApiError(error) instanceof NativeDeliveryRejected;
}
