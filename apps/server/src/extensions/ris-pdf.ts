import { mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { connectorWorkspace } from "../connectors/workspace.js";
import { workspaceContentPath } from "../project-storage-paths.js";
import type { SaveRisPdf } from "../ris/tools/download-pdf.js";

export async function risPdfDownload(config: ServerConfig, context: Record<string, unknown>, signal: AbortSignal): Promise<SaveRisPdf> {
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
  const render = config.renderHtmlPdf;
  if (!render) throw new ApiError(503, "ris_pdf_unavailable", "RIS PDF downloads require a LegalWork desktop host with PDF rendering.");
  const workspace = await connectorWorkspace(config, context);
  const root = await realpath(workspaceContentPath(workspace));
  return async document => {
    const pdf = await render(document, signal);
    signal.throwIfAborted();
    if (pdf.length < 5 || Buffer.from(pdf.subarray(0, 5)).toString() !== "%PDF-")
      throw new ApiError(502, "ris_pdf_invalid", "The RIS document could not be rendered as a PDF. No file was saved.");
    const folder = join(root, "Downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (await realpath(folder) !== folder) throw new ApiError(403, "ris_pdf_path_invalid", "The project's Downloads folder must not be a symbolic link.");
    const name = basename(document.filename), extension = extname(name), stem = name.slice(0, -extension.length);
    for (let index = 0; index < 10000; index++) {
      signal.throwIfAborted();
      const filename = index ? `${stem} (${index + 1})${extension}` : name;
      const path = join(folder, filename);
      let file;
      try { file = await open(path, "wx", 0o600); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") continue; throw error; }
      try {
        try { await file.writeFile(pdf); } finally { await file.close(); }
        signal.throwIfAborted();
        return { path, relativePath: `Downloads/${filename}`, filename, mimeType: "application/pdf", size: pdf.length };
      } catch (error) { await rm(path, { force: true }); throw error; }
    }
    throw new ApiError(409, "ris_pdf_name_unavailable", "Could not reserve a unique PDF filename in Downloads.");
  };
}
