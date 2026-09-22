import { classifyOpenTarget } from "../../session/artifacts/open-target";

/** Match the app's editors and previews, with a download for other formats. */
export function workflowResourceType(name: string) {
  const preview = classifyOpenTarget(name, "file");
  if (preview === "sheet") {
    if (/\.(csv|tsv)$/i.test(name)) return "csv";
    return /\.xlsx$/i.test(name) ? "xlsx" : "external";
  }
  if (preview === "slides") return /\.pptx$/i.test(name) ? "pptx" : "external";
  return preview;
}

export function isTextWorkflowResource(name: string) {
  return ["markdown", "text", "html", "csv"].includes(workflowResourceType(name));
}

export function isDocumentWorkflowResource(name: string) {
  return ["word", "xlsx", "pptx", "csv"].includes(workflowResourceType(name));
}

export function isEditableWorkflowResource(name: string) {
  return isTextWorkflowResource(name) || isDocumentWorkflowResource(name);
}

export function workflowResourceMime(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm", aiff: "audio/aiff", aif: "audio/aiff",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska", avi: "video/x-msvideo",
  };
  return types[extension] ?? "application/octet-stream";
}
