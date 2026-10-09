import { z } from "zod";

/** Used only for an explicitly shared report. Never pass this to automatic analytics. */
export const FullErrorDetailsSchema = z.object({
  schema_version: z.literal(1),
  collected_at: z.iso.datetime(),
  error: z.json(),
  context: z.json(),
  attachments: z.record(z.string(), z.json()),
  unavailable: z.array(z.string()),
}).strict();
export type FullErrorDetails = z.infer<typeof FullErrorDetailsSchema>;
export type ErrorDetailValue = z.infer<ReturnType<typeof z.json>>;
const SECRET_FIELD = /^(?:.*(?:authorization|api[-_]?key|(?:access|refresh|host|auth)[-_]?token)|cookie|set-cookie|password|secret|credentials?|token)$/i;

export function redactDiagnosticSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|host[-_]?token|password|secret|credential|authorization|cookie)["']?\s*[:=]\s*)(["']?)[^"'\s,;&}]+\2/gi, "$1$2<redacted>$2");
}

/** Snapshot non-enumerable Error fields and SDK responses without executing custom getters. */
export function snapshotErrorDetails(input: unknown): ErrorDetailValue {
  const seen = new WeakSet<object>();
  let remaining = 2_000_000;
  let nodes = 10_000;
  function visit(value: unknown, depth: number): ErrorDetailValue {
    if (--nodes < 0 || remaining <= 0 || depth > 20) return "[truncated: diagnostic safety limit]";
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      const clean = redactDiagnosticSecrets(value);
      const result = clean.length > remaining ? `${clean.slice(0, remaining)}[truncated: diagnostic safety limit]` : clean;
      remaining -= result.length;
      return result;
    }
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return String(value);
    if (typeof value !== "object") return `[${typeof value}]`;
    if (seen.has(value)) return "[circular or repeated reference]";
    seen.add(value);
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";
    if (value instanceof Headers) return visit(Object.fromEntries(value), depth + 1);
    if (value instanceof Map || value instanceof Set) {
      const result: ErrorDetailValue[] = [];
      const entries = value instanceof Map ? Map.prototype.entries.call(value) : Set.prototype.values.call(value);
      for (const entry of entries) {
        if (nodes <= 0 || remaining <= 0) { result.push("[truncated: diagnostic safety limit]"); break; }
        if (value instanceof Map && Array.isArray(entry) && typeof entry[0] === "string" && SECRET_FIELD.test(entry[0])) {
          result.push([entry[0], "<redacted>"]); nodes -= 2; remaining -= entry[0].length + 10;
        }
        else result.push(visit(entry, depth + 1));
      }
      return result;
    }
    if (Array.isArray(value)) {
      const result: ErrorDetailValue[] = [];
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index++) {
        if (nodes <= 0 || remaining <= 0) { result.push("[truncated: diagnostic safety limit]"); break; }
        const descriptor = descriptors[String(index)];
        result.push(descriptor && !("value" in descriptor) ? "[accessor omitted]" : visit(descriptor?.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, ErrorDetailValue> = {};
    if (value instanceof DOMException) {
      // DOMException stores these on trusted native accessors, not own fields.
      for (const key of ["name", "message", "code"]) {
        const getter = Object.getOwnPropertyDescriptor(DOMException.prototype, key)?.get;
        if (getter) result[key] = visit(getter.call(value), depth + 1);
      }
    } else if (value instanceof Error) {
      let prototype: object | null = value;
      let name: PropertyDescriptor | undefined;
      for (let i = 0; prototype && i < 10 && !name; i++) {
        name = Object.getOwnPropertyDescriptor(prototype, "name");
        prototype = Object.getPrototypeOf(prototype);
      }
      result.name = typeof name?.value === "string" ? redactDiagnosticSecrets(name.value) : "Error";
      if (result.name === "Error") {
        const constructor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "constructor");
        const className = typeof constructor?.value === "function" ? Object.getOwnPropertyDescriptor(constructor.value, "name")?.value : null;
        if (typeof className === "string" && className) result.name = redactDiagnosticSecrets(className);
      }
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (nodes <= 0 || remaining <= 0) { result.diagnostic_truncated = true; break; }
      if (typeof descriptor.value === "function") continue;
      const secret = SECRET_FIELD.test(key);
      Object.defineProperty(result, key, { enumerable: true, configurable: true, value: secret ? "<redacted>" : "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor omitted]" });
      remaining -= key.length;
    }
    return result;
  }
  try { return visit(input, 0); } catch { return "[error details could not be read]"; }
}

export function createFullErrorDetails(error: unknown, context: unknown = {}): FullErrorDetails {
  return {
    schema_version: 1, collected_at: new Date().toISOString(),
    error: snapshotErrorDetails(error), context: snapshotErrorDetails(context), attachments: {}, unavailable: [],
  };
}

function object(value: ErrorDetailValue): Record<string, ErrorDetailValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** PostHog's manual exception contract, plus the lossless snapshot kept in error_details. */
export function fullExceptionList(details: FullErrorDetails) {
  const server = object(details.attachments.server ?? null);
  const desktop = object(details.attachments.desktop ?? null);
  const platform = server?.error || (!details.error && desktop?.error) ? "node:javascript" : "web:javascript";
  function exception(value: ErrorDetailValue, depth = 0): { type: string; value: string; mechanism: { type: string; handled: boolean }; stacktrace?: { type: string; frames: { platform: string; filename: string; function?: string; lineno: number; colno: number }[] } }[] {
    const error = object(value);
    const data = error ? object(error.data ?? null) : null;
    const name = typeof error?.name === "string" ? error.name : "Error";
    const message = typeof error?.message === "string" ? error.message : typeof data?.message === "string" ? data.message : typeof value === "string" ? value : "Error details attached";
    const stack = typeof error?.stack === "string" ? error.stack : typeof data?.stack === "string" ? data.stack : "";
    const frames = stack.split("\n").flatMap(line => {
      const match = line.trim().match(/^(?:at\s+(?:(.*?)\s+\()?|(?:(.*?)@))(.+?):(\d+):(\d+)\)?$/);
      if (!match) return [];
      const fn = match[1] || match[2];
      return [{ platform, filename: match[3], ...(fn ? { function: fn } : {}), lineno: Number(match[4]), colno: Number(match[5]) }];
    }).reverse();
    const causes = depth < 10 && error?.cause ? exception(error.cause, depth + 1) : [];
    return [...causes, { type: name, value: message, mechanism: { type: "manual", handled: true }, ...(frames.length ? { stacktrace: { type: "raw", frames } } : {}) }];
  }
  return exception(server?.error ?? details.error ?? desktop?.error ?? null);
}
