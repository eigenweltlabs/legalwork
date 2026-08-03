/**
 * Filename hygiene for a document exported out of LegalMemory.
 *
 * This module used to validate the appliance's `/api/downloads/…` capability
 * URLs, because the app fetched them itself and they arrived out of model
 * output. It no longer does: the bytes now come back inside the MCP tool result
 * (see legalmemory-fetch.ts), so the app never handles a URL at all and that
 * whole surface is gone. What survives is the part that still matters, turning
 * a name the appliance chose into one that can only land in the workspace root.
 */

/**
 * Reduce a name from the appliance to something that can only ever land
 * directly in the workspace root.
 */
export function safeExportFilename(name: string): string | null {
  // Both separators, whatever the appliance's own platform was.
  const base = name.split(/[/\\]/).pop()?.trim() ?? "";
  if (!base || base === "." || base === "..") return null;
  // Control characters and the Windows-reserved set; a document name should
  // never contain them, and they are how a name becomes something else.
  if (/[\x00-\x1f\x7f<>:"|?*]/.test(base)) return null;
  // A leading dot would hide the export from the workspace listing the user is
  // looking at, which reads as the export having failed.
  if (base.startsWith(".")) return null;
  return base.length > 200 ? base.slice(0, 200) : base;
}
