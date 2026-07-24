/**
 * Executor for the *_run_code agent tools: runs a model-written Office.js
 * batch inside the pane and returns a JSON-serializable result over the
 * relay. One escape hatch per host gives the agent the full document API
 * without a typed tool per capability.
 *
 * Sandbox honesty: the snippet executes in the pane's JS realm. Every
 * pane global that is not a document API is shadowed with undefined so
 * honest code only sees Office objects — that is a guard against
 * accidents, not a security boundary (the agent already runs arbitrary
 * code on this machine through its workspace tools).
 *
 * In Word, change tracking is forced on around the batch so document
 * mutations stay reviewable redlines, mirroring the typed word_* tools.
 * Hosts without WordApi 1.4 cannot control tracking; the batch still runs
 * and the result carries trackedChanges: false plus a warning to relay.
 */
import { isWordApiSupported, untrackedEditWarning, wordRun } from "./office";
import { excelRun } from "./excel-api";
import { powerPointRun } from "./powerpoint-api";

type RunHost = "word" | "excel" | "powerpoint";

const MAX_RESULT_CHARS = 30_000;
const MAX_LOG_ENTRIES = 40;
const MAX_LOG_CHARS = 500;

// Pane globals that snippet code has no business touching. They become
// unbound parameters, so plain identifier access resolves to undefined
// inside the snippet.
const SHADOWED_GLOBALS = [
  "window",
  "document",
  "globalThis",
  "self",
  "top",
  "parent",
  "frames",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",
  "open",
  "close",
  "postMessage",
  "importScripts",
  // "eval" is not shadowable (illegal parameter name in strict mode) —
  // consistent with this being an accident guard, not a security boundary.
  "Function",
  "OfficeRuntime",
];

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function serializeResult(value: unknown): unknown {
  if (value === undefined) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, entry) => (typeof entry === "function" ? "[function]" : entry));
  } catch {
    return String(value);
  }
  if (text === undefined) return String(value);
  if (text.length > MAX_RESULT_CHARS) {
    return { truncated: true, totalChars: text.length, preview: text.slice(0, MAX_RESULT_CHARS) };
  }
  return JSON.parse(text) as unknown;
}

function officeApiGlobals(): Record<"Office" | "Word" | "Excel" | "PowerPoint", unknown> {
  const scope = window as unknown as Record<string, unknown>;
  return { Office: scope.Office, Word: scope.Word, Excel: scope.Excel, PowerPoint: scope.PowerPoint };
}

function buildSnippet(code: string): (...args: unknown[]) => Promise<unknown> {
  return new Function(
    "context",
    "Office",
    "Word",
    "Excel",
    "PowerPoint",
    "console",
    ...SHADOWED_GLOBALS,
    `"use strict";\nreturn (async () => {\n${code}\n})();`,
  ) as (...args: unknown[]) => Promise<unknown>;
}

/** Office.js errors carry debugInfo (statement, surrounding code) the model needs to self-correct. */
function describeOfficeError(error: unknown): Error {
  const err = error as { name?: string; message?: string; debugInfo?: unknown } | null;
  const debugInfo = err?.debugInfo
    ? ` OfficeExtension debugInfo: ${formatLogValue(err.debugInfo).slice(0, 600)}`
    : "";
  return new Error(`${err?.name ?? "Error"}: ${err?.message ?? String(error)}${debugInfo}`);
}

export async function runOfficeCode(host: RunHost, args: Record<string, unknown>): Promise<unknown> {
  const code = typeof args.code === "string" ? args.code.trim() : "";
  if (!code) {
    throw new Error("code is required: the body of a Word.run/Excel.run/PowerPoint.run batch.");
  }

  const logs: string[] = [];
  const push = (level: string, values: unknown[]) => {
    if (logs.length >= MAX_LOG_ENTRIES) return;
    logs.push(`[${level}] ${values.map(formatLogValue).join(" ")}`.slice(0, MAX_LOG_CHARS));
  };
  const consoleProxy = {
    log: (...values: unknown[]) => push("log", values),
    info: (...values: unknown[]) => push("info", values),
    warn: (...values: unknown[]) => push("warn", values),
    error: (...values: unknown[]) => push("error", values),
  };

  const snippet = buildSnippet(code);
  const apis = officeApiGlobals();
  const execute = (context: unknown): Promise<unknown> =>
    snippet(context, apis.Office, apis.Word, apis.Excel, apis.PowerPoint, consoleProxy);

  const wordTracking = host === "word" ? isWordApiSupported("1.4") : false;

  try {
    let result: unknown;
    if (host === "word") {
      result = await wordRun(async (context) => {
        if (!wordTracking) {
          const value = await execute(context);
          await context.sync();
          return value;
        }
        // Mirror withTrackedChanges in word-document-tools: every mutation
        // the snippet makes must land as a reviewable redline.
        const document = context.document;
        document.load("changeTrackingMode");
        await context.sync();
        const originalMode = document.changeTrackingMode;
        if (originalMode !== "TrackAll") {
          document.changeTrackingMode = "TrackAll";
          await context.sync();
        }
        try {
          const value = await execute(context);
          await context.sync();
          return value;
        } finally {
          if (originalMode !== "TrackAll") {
            document.changeTrackingMode = originalMode;
            await context.sync();
          }
        }
      });
    } else if (host === "excel") {
      result = await excelRun(async (context) => {
        const value = await execute(context);
        await context.sync();
        return value;
      });
    } else {
      result = await powerPointRun(async (context) => {
        const value = await execute(context);
        await context.sync();
        return value;
      });
    }
    return {
      result: serializeResult(result),
      ...(logs.length ? { logs } : {}),
      ...(host === "word"
        ? { trackedChanges: wordTracking, ...(wordTracking ? {} : { warning: untrackedEditWarning() }) }
        : {}),
    };
  } catch (error) {
    throw describeOfficeError(error);
  }
}
