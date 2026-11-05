import { isAbsolute, resolve, win32 } from "node:path";
import { ApiError } from "./errors.js";

export function originalImageExportPath(directory: string, path: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  if (isAbsolute(path) || win32.isAbsolute(path) || !parts.length || parts.some(part => !part || part === "." || part === ".." || part.includes("\0")
    || part.includes(":") || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ApiError(400, "invalid_original_export_path", "Choose a project-relative file path without special path components.");
  return resolve(directory, ...parts);
}
