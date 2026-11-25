// What may leave the machine in an error report. Pure functions, no Electron
// imports, so the rules are unit-tested (error-reporting-scrub.test.mjs).
//
// Error reports exist to find bugs in LegalWork's own code. They carry the
// error type, the code location and a cleaned message. They never carry
// document text, file or folder names, prompts, e-mail addresses, local
// variable values, request bodies or the computer's name. Every event passes
// scrubEvent() in the main process, including events from app windows, which
// the SDK forwards to the main process before sending.

const MAX_TEXT = 500;

// Breadcrumb categories that can echo what the user typed, clicked or opened.
const DROPPED_BREADCRUMB_CATEGORIES = new Set(["console", "navigation", "ui.click", "ui.input", "ui.keypress", "sentry.event"]);

const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>|*?\n]*/g;
const UNC_PATH = /\\\\[^\s"'`<>|*?\n]+/g;
const FILE_URL = /\bfile:\/\/[^\s"'`<>\n]*/gi;
const POSIX_PATH = /(?<![\w.:/])\/(?:Users|home|private|var|tmp|Volumes|mnt|media|opt|root|etc|Library|Applications)(?:\/[^\s"'`<>\n]*)?/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_WITH_PARAMS = /\b(https?:\/\/[^\s"'`<>?#\n]+)[?#][^\s"'`<>\n]*/gi;
const LONG_NUMBER = /\b\d{8,}\b/g;
// Quoted text longer than 40 characters is content (a document title, a
// sentence), not a code identifier.
const QUOTED = /(["'`])((?:(?!\1).){41,})\1/g;

// A quoted string that starts like a path is a path, spaces included
// ('/Users/anna/Müller GmbH/Klage.docx'), so it is replaced as a whole.
const QUOTED_PATH = /(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/|file:\/\/)(?:(?!\1).)*\1/gi;

// An unquoted path stops at the first space, which would leak the rest of a
// folder name ("<path> GmbH/Klage.docx"). Words that follow a replaced path
// belong to it up to the last one that still contains a path separator.
function absorbPathTails(text) {
  return text.replace(/<path>((?:\s+[^\s"'`<>]+){1,6})/g, (match, tail) => {
    const words = tail.match(/\s+[^\s"'`<>]+/g) ?? [];
    let last = -1;
    words.forEach((word, index) => {
      if (/[\\/]/.test(word)) last = index;
    });
    return last < 0 ? match : `<path>${words.slice(last + 1).join("")}`;
  });
}

/** Replace paths, e-mails, URL parameters, long numbers and long quoted text in free text. */
export function scrubText(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let text = value
    .replace(QUOTED_PATH, (_match, quote) => `${quote}<path>${quote}`)
    .replace(FILE_URL, "<path>")
    .replace(UNC_PATH, "<path>")
    .replace(WINDOWS_PATH, "<path>")
    .replace(POSIX_PATH, "<path>");
  text = absorbPathTails(text)
    .replace(EMAIL, "<email>")
    .replace(URL_WITH_PARAMS, "$1?<params>")
    .replace(LONG_NUMBER, "<number>")
    .replace(QUOTED, (_match, quote) => `${quote}<text>${quote}`);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
  return text;
}

// Frames inside the packaged app (app.asar) or already normalised by the SDK
// (app:///) are LegalWork's own open-source code and stay readable. Anything
// else is a path on the user's disk; only its file name is kept.
function scrubFramePath(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.startsWith("app:///") || value.startsWith("node:") || value.includes("app.asar")) return value;
  if (!/[\\/]/.test(value)) return value;
  const name = value.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return `<path>/${name}`;
}

function scrubFrames(frames) {
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    delete frame.vars;
    if ("filename" in frame) frame.filename = scrubFramePath(frame.filename);
    if ("abs_path" in frame) frame.abs_path = scrubFramePath(frame.abs_path);
    if ("module" in frame && typeof frame.module === "string" && /[\\/]/.test(frame.module)) frame.module = scrubFramePath(frame.module);
  }
}

function scrubValues(value, depth = 0) {
  if (typeof value === "string") return scrubText(value);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValues(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) out[key] = scrubValues(item, depth + 1);
  return out;
}

function scrubUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return "<path>";
    return `${url.protocol}//${url.host}${scrubText(url.pathname)}`;
  } catch {
    return scrubText(value);
  }
}

/** Clean or drop a breadcrumb. Returns null to drop it. */
export function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return null;
  const category = typeof breadcrumb.category === "string" ? breadcrumb.category : "";
  if (DROPPED_BREADCRUMB_CATEGORIES.has(category) || category.startsWith("ui.")) return null;
  const out = { ...breadcrumb };
  if (typeof out.message === "string") out.message = scrubText(out.message);
  if (out.data && typeof out.data === "object") {
    const data = {};
    for (const [key, item] of Object.entries(out.data)) {
      // Bodies and headers can hold document text or credentials.
      if (/body|header|cookie|payload|query|input|output/i.test(key)) continue;
      data[key] = /url|href|from|to/i.test(key) ? scrubUrl(item) : scrubValues(item);
    }
    out.data = data;
  }
  return out;
}

/** Clean a Sentry event in place and return it (or null to drop it). */
export function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;
  // The computer's name is often the person's name ("Annas-MacBook-Pro").
  delete event.server_name;
  delete event.user;
  delete event.request;
  if (event.contexts?.device && typeof event.contexts.device === "object") delete event.contexts.device.name;

  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.logentry && typeof event.logentry === "object") {
    if (typeof event.logentry.message === "string") event.logentry.message = scrubText(event.logentry.message);
    if (typeof event.logentry.formatted === "string") event.logentry.formatted = scrubText(event.logentry.formatted);
    delete event.logentry.params;
  }
  for (const value of event.exception?.values ?? []) {
    if (!value || typeof value !== "object") continue;
    if (typeof value.value === "string") value.value = scrubText(value.value);
    scrubFrames(value.stacktrace?.frames);
  }
  for (const thread of event.threads?.values ?? []) scrubFrames(thread?.stacktrace?.frames);
  if (event.extra && typeof event.extra === "object") event.extra = scrubValues(event.extra);
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  } else if (Array.isArray(event.breadcrumbs?.values)) {
    event.breadcrumbs.values = event.breadcrumbs.values.map(scrubBreadcrumb).filter(Boolean);
  }
  return event;
}

/**
 * Wrap a Sentry transport so nothing leaves the machine unless reporting is
 * allowed. Covers every envelope type: errors, sessions and anything else the
 * SDK sends. Envelopes refused here are dropped, not queued for later.
 */
export function createConsentGatedTransport(inner, isAllowed) {
  return {
    send(envelope) {
      return isAllowed() ? inner.send(envelope) : Promise.resolve({});
    },
    flush(timeout) {
      return inner.flush(timeout);
    },
  };
}
