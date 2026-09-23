// Handing a URL or a path to the operating system can start a program, so
// everything the renderer (or a web page) asks us to open is classified first.
// The classifiers are pure; createSafeOpen() wires them to Electron.
import path from "node:path";

// Opened without asking: ordinary web and mail links.
const WEB_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// Never handed to the OS. `file:` has its own path-based rules below, and the
// rest are ways to pull in local or scripted content.
const REFUSED_SCHEMES = new Set(["file:", "javascript:", "data:", "blob:", "vbscript:", "about:", "chrome:", "devtools:"]);

// Opened without asking: formats whose default app only views or edits them.
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".rtf", ".csv", ".tsv", ".log",
  ".doc", ".docx", ".odt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp", ".pages", ".numbers", ".key",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".avif",
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus",
  ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv",
  ".eml", ".msg", ".ics", ".vcf",
]);

// Never opened, only revealed in the file manager: these run code. Office
// macro formats are here too — opening one can prompt to enable macros.
const EXECUTABLE_EXTENSIONS = new Set([
  ".app", ".command", ".workflow", ".action", ".scpt", ".applescript", ".osascript", ".terminal", ".dmg", ".pkg", ".mpkg",
  ".exe", ".msi", ".msp", ".msc", ".bat", ".cmd", ".com", ".scr", ".pif", ".cpl", ".hta", ".gadget", ".lnk", ".url", ".reg", ".inf",
  ".vbs", ".vbe", ".js", ".jse", ".mjs", ".cjs", ".wsf", ".wsh", ".ps1", ".psm1", ".ps1xml",
  ".sh", ".bash", ".zsh", ".csh", ".ksh", ".fish", ".py", ".rb", ".pl", ".php", ".jar", ".class",
  ".deb", ".rpm", ".appimage", ".run", ".bin", ".apk", ".ipa",
  ".webloc", ".inetloc", ".desktop", ".so", ".dylib", ".dll",
  ".docm", ".dotm", ".xlsm", ".xltm", ".xlam", ".pptm", ".potm", ".ppam", ".sldm",
]);

/**
 * @param {string | null | undefined} url
 * @returns {{ action: "open" } | { action: "confirm", scheme: string } | { action: "refuse", reason: string }}
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
  if (REFUSED_SCHEMES.has(scheme)) return { action: "refuse", reason: scheme };
  // Anything else is an app link (ms-word:, zoommtg:, slack:, tel:, …): useful,
  // but it starts another program, so the user confirms it.
  return { action: "confirm", scheme };
}

/**
 * @param {string | null | undefined} filePath
 * @returns {{ action: "open" } | { action: "confirm", extension: string } | { action: "reveal", reason: string }}
 */
export function classifyFileOpen(filePath) {
  const value = String(filePath ?? "").trim();
  if (!value) return { action: "reveal", reason: "empty" };
  if (value.includes("\0")) return { action: "reveal", reason: "null byte" };
  const extension = path.extname(value).toLowerCase();
  // No extension: the OS decides by file mode, which may mean "execute".
  if (!extension) return { action: "reveal", reason: "no extension" };
  if (EXECUTABLE_EXTENSIONS.has(extension)) return { action: "reveal", reason: extension };
  if (DOCUMENT_EXTENSIONS.has(extension)) return { action: "open" };
  return { action: "confirm", extension };
}

/**
 * @param {{
 *   shell: {
 *     openExternal: (url: string) => Promise<unknown>,
 *     openPath: (path: string) => Promise<string> | Promise<unknown>,
 *     showItemInFolder: (path: string) => unknown,
 *   },
 *   confirm: (options: { message: string, detail: string }) => Promise<boolean>,
 *   log?: (message: string) => void,
 * }} deps
 */
export function createSafeOpen({ shell, confirm, log = console.warn }) {
  return {
    /** Open a link with the OS, asking first for anything that is not http/https/mailto. */
    async openExternal(url) {
      const verdict = classifyExternalUrl(url);
      if (verdict.action === "refuse") {
        log(`[security] refused to open a link (${verdict.reason})`);
        return false;
      }
      if (verdict.action === "confirm") {
        const allowed = await confirm({
          message: `Open this link in another app?`,
          detail: `LegalWork wants to hand a "${verdict.scheme.replace(/:$/, "")}" link to another application on your computer.\n\n${String(url).slice(0, 300)}`,
        });
        if (!allowed) return false;
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
      if (verdict.action === "confirm") {
        const allowed = await confirm({
          message: `Open ${path.basename(target)}?`,
          detail: `LegalWork does not recognise "${verdict.extension}" files and will open this one with whichever app your computer has registered for it.`,
        });
        if (!allowed) {
          shell.showItemInFolder(target);
          return "";
        }
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
