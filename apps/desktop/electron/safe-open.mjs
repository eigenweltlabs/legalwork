// Handing a URL or a path to the operating system can start a program, so
// everything the renderer (or a web page) asks us to open is classified first.
// The classifiers are pure; createSafeOpen() wires them to Electron.
import path from "node:path";

// Only ordinary web and mail links may be handed off by untrusted content.
const WEB_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// Only recognised document formats are handed to their default application.
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".rtf", ".csv", ".tsv", ".log",
  ".doc", ".docx", ".odt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp", ".pages", ".numbers", ".key",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".avif",
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus",
  ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv",
  ".eml", ".msg", ".ics", ".vcf",
]);

/**
 * @param {string | null | undefined} url
 * @returns {{ action: "open" } | { action: "refuse", reason: string }}
 */
export function classifyExternalUrl(url) {
  const value = String(url ?? "").trim();
  if (!value) return { action: "refuse", reason: "empty" };
  // A NUL byte can hide the real scheme or extension from these checks.
  if (value.includes("\0")) return { action: "refuse", reason: "null byte" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { action: "refuse", reason: "not a URL" };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (WEB_SCHEMES.has(scheme)) return { action: "open" };
  return { action: "refuse", reason: scheme };
}

/**
 * @param {string | null | undefined} filePath
 * @returns {{ action: "open" } | { action: "reveal", reason: string }}
 */
export function classifyFileOpen(filePath) {
  const value = String(filePath ?? "").trim();
  if (!value) return { action: "reveal", reason: "empty" };
  if (value.includes("\0")) return { action: "reveal", reason: "null byte" };
  const extension = path.extname(value).toLowerCase();
  // No extension: the OS decides by file mode, which may mean "execute".
  if (!extension) return { action: "reveal", reason: "no extension" };
  if (DOCUMENT_EXTENSIONS.has(extension)) return { action: "open" };
  return { action: "reveal", reason: extension };
}

/**
 * @param {{
 *   shell: {
 *     openExternal: (url: string) => Promise<unknown>,
 *     openPath: (path: string) => Promise<string> | Promise<unknown>,
 *     showItemInFolder: (path: string) => unknown,
 *   },
 *   log?: (message: string) => void,
 * }} deps
 */
export function createSafeOpen({ shell, log = console.warn }) {
  return {
    /** Open only http/https/mailto links with the OS. */
    async openExternal(url) {
      const verdict = classifyExternalUrl(url);
      if (verdict.action === "refuse") {
        log(`[security] refused to open a link (${verdict.reason})`);
        return false;
      }
      await shell.openExternal(String(url));
      return true;
    },

    /** Open a file with its default app; reveal it instead when that would run code. */
    async openPath(filePath) {
      const target = String(filePath ?? "");
      const verdict = classifyFileOpen(target);
      if (verdict.action === "reveal") {
        log(`[security] showing ${target} in the file manager instead of opening it (${verdict.reason})`);
        if (target && !target.includes("\0")) shell.showItemInFolder(target);
        return "";
      }
      return shell.openPath(target);
    },

    /** Reveal a file in Finder/Explorer. Always safe — nothing is launched. */
    showItemInFolder(filePath) {
      const target = String(filePath ?? "");
      if (target && !target.includes("\0")) shell.showItemInFolder(target);
    },
  };
}
