// Main-process error log: mirrors console.error/console.warn into
// <logs>/main.log. The embedded server runs inside this process and reports
// unexpected route failures (with the stack) only through console.error, and a
// packaged build has no terminal attached, so without this file the cause
// behind a generic "Unexpected server error" is lost. support-bundle.mjs reads
// every *.log in the logs folder, so these entries reach "Collect Support
// Logs..." without further wiring.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { formatWithOptions } from "node:util";

// Past this size main.log is rotated to main.old.log, which keeps the file
// bounded while the support bundle still sees the latest entries.
const MAX_LOG_BYTES = 1_000_000;

// Node's console defaults cut nested error details below depth 2 and strings
// after 10,000 characters; the file keeps them whole.
const FULL_DETAIL = { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity };

/**
 * `getLogsDir` is resolved on the first write, so main.mjs must install this
 * after it has set the app name and userData path (the logs folder derives
 * from both).
 */
export function installMainErrorLog(getLogsDir) {
  // Node keeps 10 stack frames by default, which for a library error (e.g. a
  // YAML parse failure) ends before the app code that called it.
  Error.stackTraceLimit = 100;
  let logPath = null;
  let logBytes = 0;

  function append(level, args) {
    try {
      if (!logPath) {
        const dir = getLogsDir();
        mkdirSync(dir, { recursive: true });
        logPath = path.join(dir, "main.log");
        try {
          logBytes = statSync(logPath).size;
        } catch {
          logBytes = 0;
        }
      }
      if (logBytes > MAX_LOG_BYTES) {
        logBytes = 0;
        renameSync(logPath, path.join(path.dirname(logPath), "main.old.log"));
      }
      const entry = `[${new Date().toISOString()}] ${level} ${formatWithOptions(FULL_DETAIL, ...args)}\n`;
      appendFileSync(logPath, entry, "utf8");
      logBytes += Buffer.byteLength(entry);
    } catch {
      // Logging must never break the caller.
    }
  }

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => {
    append("ERROR", args);
    originalError.apply(console, args);
  };
  console.warn = (...args) => {
    append("WARN", args);
    originalWarn.apply(console, args);
  };
}
