import type { UIMessage } from "ai";

import { LEGALMEMORY_URI_PATTERN } from "@/components/markdown/legalmemory-ref";

type OpenTargetKind = "url" | "file";
export type OpenTargetPreview = "browser" | "markdown" | "sheet" | "slides" | "word" | "image" | "pdf" | "html" | "text" | "external";

export interface TextData {
  kind: "text";
  data: string;
}

export interface BinaryData {
  kind: "binary";
  data: ArrayBuffer;
}

export type Data = TextData | BinaryData;

export type OpenTarget = {
  id: string;
  kind: OpenTargetKind;
  value: string;
  name: string;
  preview: OpenTargetPreview;
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
};

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;

const FILE_PATTERN = /(?:^|[\s"'`([{*])((?:\.{1,2}[/\\]|~[/\\]|[/\\])?[\w.\-]+(?:[/\\][\w.\-]+)+\.[a-z][a-z0-9]{0,9}|[\w.\-]+\.[a-z][a-z0-9]{0,9})/gi;
const URL_PATTERN = /https?:\/\/[^\s)\]}>"'`]+/gi;
const SOCKET_PATTERN = /(?:ws|wss):\/\/[^\s)\]}>"'`]+/gi;
const SIDEBAR_ARTIFACT_FILE_PREVIEWS = new Set<OpenTargetPreview>(["markdown", "sheet", "slides", "word", "image", "pdf", "html"]);
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const DISCOVERY_TOOL_NAMES = new Set(["glob", "grep", "search", "find"]);
const ARTIFACT_METADATA_TOOL_NAMES = new Set(["legalwork_extension_call"]);
const WRITE_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "edit_file",
  "multi_edit",
  "multiedit",
  "patch",
  "str_replace_editor",
  "write",
  "write_file",
]);
const FILE_METADATA_KEYS = ["path", "file", "filePath", "filepath"];
const PATCH_FILE_PATTERN = /^\*\*\* (?:Add File|Update File):\s*(.+)$/gmi;
const PATCH_MOVE_TO_PATTERN = /^\*\*\* Move to:\s*(.+)$/gmi;
const URI_PATTERN = /^(?:https?|wss?|file):\/\//i;

type DeriveOpenTargetsOptions = {
  includeFileMentions?: boolean;
};

function normalizePath(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "");
}

function basename(value: string) {
  const clean = value.split(/[?#]/)[0] ?? value;
  return clean.split("/").filter(Boolean).pop() ?? value;
}

function extname(value: string) {
  const name = basename(value).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

export function classifyOpenTarget(value: string, kind: OpenTargetKind): OpenTargetPreview {
  if (kind === "url") return "browser";
  const ext = extname(value);
  if ([".md", ".markdown", ".mdx"].includes(ext)) return "markdown";
  if ([".csv", ".tsv", ".xlsx", ".xls", ".ods"].includes(ext)) return "sheet";
  if ([".ppt", ".pptx", ".pptm", ".pot", ".potx", ".odp", ".key", ".sxi"].includes(ext)) return "slides";
  // OOXML wordprocessing formats only — the in-app docx editor parses the .docx zip/xml package.
  // Legacy/non-OOXML word docs (.doc, .odt, .rtf, .pages) stay "external" (open in Word).
  if ([".docx", ".docm", ".dotx", ".dotm"].includes(ext)) return "word";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".html", ".htm"].includes(ext)) return "html";
  if ([".txt", ".log", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss"].includes(ext)) return "text";
  return "external";
}

function textWithoutRedundantMarkdownLinkLabels(text: string) {
  return text.replace(MARKDOWN_LINK_PATTERN, (match, label: string, href: string) => {
    const cleanLabel = label.trim();
    const cleanHref = href.trim();
    return cleanLabel === basename(cleanHref) ? `[](${cleanHref})` : match;
  });
}

function targetFromFile(path: string, confidence: number, reason: string): OpenTarget | null {
  const normalized = normalizePath(path).replace(/[.,;:]+$/, "");
  if (!normalized || normalized.length > 500 || !normalized.includes(".")) return null;
  return {
    id: `file:${normalized.toLowerCase()}`,
    kind: "file",
    value: normalized,
    name: basename(normalized),
    preview: classifyOpenTarget(normalized, "file"),
    confidence,
    reason,
  };
}

function targetFromUrl(url: string, confidence: number, reason: string): OpenTarget | null {
  const stripped = url.trim().replace(/[.,;:`\\]+$/, "");
  let clean = stripped;
  try {
    const parsed = new URL(stripped);
    if (/^\/+$/i.test(parsed.pathname) && !parsed.search && !parsed.hash) {
      clean = parsed.origin;
    }
  } catch {
    // Keep the stripped value; regex extraction already validated the shape.
  }
  if (!clean) return null;
  return {
    id: `url:${clean}`,
    kind: "url",
    value: clean,
    name: basename(clean) || clean,
    preview: "browser",
    confidence,
    reason,
  };
}

function addTarget(map: Map<string, OpenTarget>, target: OpenTarget | null) {
  if (!target) return;
  const existing = map.get(target.id);
  if (!existing || target.confidence >= existing.confidence) map.set(target.id, target);
}

function isArtifactTarget(target: OpenTarget) {
  return target.kind === "url" || target.kind === "file";
}

export function isCollectibleArtifactTarget(target: OpenTarget) {
  return target.kind === "file" && target.exists === true && SIDEBAR_ARTIFACT_FILE_PREVIEWS.has(target.preview);
}

export function isOpenableFileTarget(target: OpenTarget) {
  return target.kind === "file" && target.exists === true;
}

export function isLocalhostBrowserTarget(target: OpenTarget) {
  return target.kind === "url" && /(?:https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(target.value);
}

export function selectAutoOpenTarget(_targets: OpenTarget[]): OpenTarget | null {
  return null;
}

/** Shape of the file render parts the transcript hands us (AI SDK `FileUIPart`). */
export type FilePartLike = {
  filename?: string | null;
  url?: string | null;
  mediaType?: string | null;
  providerMetadata?: unknown;
};

function opencodeSourceFromMetadata(providerMetadata: unknown): { path?: string; uri?: string } | null {
  if (!isObject(providerMetadata)) return null;
  const opencode = providerMetadata.opencode;
  if (!isObject(opencode)) return null;
  const source = opencode.source;
  if (!isObject(source)) return null;
  return {
    path: typeof source.path === "string" ? source.path : undefined,
    uri: typeof source.uri === "string" ? source.uri : undefined,
  };
}

/**
 * The workspace path a file render part points at. When the agent reads or
 * attaches a workspace file (e.g. a PDF), OpenCode records the originating
 * `source` in the part's provider metadata even though the inline `url` is a
 * `data:` blob, so we recover the real path from there first.
 */
function filePartCandidatePath(part: FilePartLike): string | null {
  const source = opencodeSourceFromMetadata(part.providerMetadata);
  if (source?.path) return source.path;
  if (source?.uri?.startsWith("file://")) return source.uri.replace(/^file:\/\//, "");
  if (part.filename && !part.filename.startsWith("data:") && part.filename.includes(".")) return part.filename;
  return null;
}

function filePathMatchesTarget(path: string, targetValue: string) {
  const normalizedPath = normalizePath(path).toLowerCase();
  const normalizedTarget = normalizePath(targetValue).toLowerCase();
  return normalizedPath === normalizedTarget || normalizedPath.endsWith(`/${normalizedTarget}`) || normalizedTarget.endsWith(`/${normalizedPath}`);
}

/**
 * Resolve a workspace file path (from a transcript badge, a prose mention, or a
 * markdown link) to an openable target. Prefers an already-verified transcript
 * target (which carries `exists`, size and the verified preview kind); otherwise
 * builds one from the path and assumes it exists, since the agent just read,
 * wrote or referenced it. Returns null for values with no usable file path.
 */
export function resolvePathOpenTarget(
  path: string,
  openTargets: OpenTarget[],
  reason = "mention",
): OpenTarget | null {
  const match = openTargets.find(
    (target) => target.kind === "file" && filePathMatchesTarget(path, target.value),
  );
  if (match) return match;
  const built = targetFromFile(path, 95, reason);
  return built ? { ...built, exists: true } : null;
}

/**
 * Resolve a transcript file badge (PDF, DOCX, image, …) to an openable target.
 * Returns null for inline-only attachments with no recoverable workspace path
 * or URL.
 */
export function resolveFilePartOpenTarget(part: FilePartLike, openTargets: OpenTarget[]): OpenTarget | null {
  const path = filePartCandidatePath(part);
  if (path) return resolvePathOpenTarget(path, openTargets, "attachment");
  const source = opencodeSourceFromMetadata(part.providerMetadata);
  const uri = source?.uri ?? (typeof part.url === "string" && URI_PATTERN.test(part.url) ? part.url : null);
  if (uri && /^https?:\/\//i.test(uri)) return targetFromUrl(uri, 80, "attachment");
  // Last resort: build a target straight from the attachment's own filename so
  // the badge stays openable. The handler decides the in-app viewer vs. the
  // system default app from the file type — the badge never needs to gate on
  // "is this openable".
  if (typeof part.filename === "string" && !part.filename.startsWith("data:")) {
    const built = targetFromFile(part.filename, 70, "attachment");
    if (built) return { ...built, exists: true };
  }
  return null;
}

function scanText(
  map: Map<string, OpenTarget>,
  text: string,
  confidence: number,
  reason: string,
  options: { includeFiles: boolean },
) {
  if (!text) {
    return;
  }

  let scanValue = text;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const href = match[2];
    if (!href) continue;
    // LegalMemory reference links are chips with their own click behavior,
    // never workspace files or browser URLs.
    if (LEGALMEMORY_URI_PATTERN.test(href)) continue;
    if (/^(?:https?|wss?):\/\//i.test(href)) {
      addTarget(map, targetFromUrl(href, confidence, reason));
    } else if (options.includeFiles) {
      addTarget(map, targetFromFile(href, confidence, reason));
    }
  }

  if (options.includeFiles) {
    scanValue = textWithoutRedundantMarkdownLinkLabels(text);
  }

  URL_PATTERN.lastIndex = 0;

  for (const match of scanValue.matchAll(URL_PATTERN)) {
    if (match[0]) addTarget(map, targetFromUrl(match[0], confidence, reason));
  }

  SOCKET_PATTERN.lastIndex = 0;

  for (const match of scanValue.matchAll(SOCKET_PATTERN)) {
    if (match[0]) addTarget(map, targetFromUrl(match[0], confidence, reason));
  }

  if (!options.includeFiles) return;

  FILE_PATTERN.lastIndex = 0;
  for (const match of scanValue.matchAll(FILE_PATTERN)) {
    if (match[1]) addTarget(map, targetFromFile(match[1], confidence, reason));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizedToolName(toolName: string) {
  return toolName.trim().toLowerCase().replace(/^functions[._-]/, "");
}

function isDiscoveryTool(toolName: string) {
  return DISCOVERY_TOOL_NAMES.has(normalizedToolName(toolName));
}

function isWriteTool(toolName: string) {
  return WRITE_TOOL_NAMES.has(normalizedToolName(toolName));
}

function isArtifactMetadataTool(toolName: string) {
  return ARTIFACT_METADATA_TOOL_NAMES.has(normalizedToolName(toolName));
}

function collectFileMetadataValues(value: unknown) {
  if (!isObject(value)) return [];
  const values: string[] = [];
  for (const key of FILE_METADATA_KEYS) {
    const file = value[key];
    if (typeof file === "string") values.push(file);
  }
  const files = value.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file === "string") values.push(file);
    }
  }
  return values;
}

function collectNestedFileMetadataValues(value: unknown) {
  if (!isObject(value)) return [];
  return [value, value.result].flatMap(collectFileMetadataValues);
}

function collectPatchFileValues(value: unknown) {
  if (!isObject(value)) return [];
  const patchText = value.patchText ?? value.patch ?? value.diff;
  if (typeof patchText !== "string") return [];
  const values: string[] = [];
  PATCH_FILE_PATTERN.lastIndex = 0;
  for (const match of patchText.matchAll(PATCH_FILE_PATTERN)) {
    if (match[1]) values.push(match[1]);
  }
  PATCH_MOVE_TO_PATTERN.lastIndex = 0;
  for (const match of patchText.matchAll(PATCH_MOVE_TO_PATTERN)) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

function addFileValues(map: Map<string, OpenTarget>, values: string[], confidence: number, reason: string) {
  for (const value of values) {
    addTarget(map, targetFromFile(value, confidence, reason));
  }
}

export function deriveOpenTargets(messages: UIMessage[], options: DeriveOpenTargetsOptions = {}): OpenTarget[] {
  const targets = new Map<string, OpenTarget>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" && typeof part.text === "string") {
        scanText(targets, part.text, message.role === "assistant" ? 65 : 40, "message", {
          includeFiles: options.includeFileMentions === true || message.role === "assistant",
        });
        continue;
      }

      if (part.type === "source-document") {
        addTarget(
          targets,
          part.filename
            ? targetFromFile(part.filename, 95, "attachment source")
            : URI_PATTERN.test(part.title)
              ? targetFromUrl(part.title, 95, "attachment source")
              : targetFromFile(part.title, 95, "attachment source"),
        );
        continue;
      }

      if (part.type !== "dynamic-tool") {
        continue;
      }

      const discoveryTool = isDiscoveryTool(part.toolName);
      const writeTool = isWriteTool(part.toolName);
      const artifactMetadataTool = isArtifactMetadataTool(part.toolName);

      if (writeTool) {
        addFileValues(
          targets,
          [part.input, part.output].flatMap(collectFileMetadataValues),
          95,
          "write tool metadata",
        );
        addFileValues(targets, collectPatchFileValues(part.input), 95, "patch metadata");
        if (typeof part.output === "string") {
          scanText(targets, part.output, 90, "write tool output", { includeFiles: true });
        }
      }

      if (artifactMetadataTool) {
        addFileValues(
          targets,
          [part.input, part.output].flatMap(collectNestedFileMetadataValues),
          95,
          "artifact tool metadata",
        );
      }

      if (!discoveryTool) {
        scanText(targets, JSON.stringify(part.output ?? part.input ?? ""), 75, "tool output", { includeFiles: false });
      }
    }
  }

  return Array.from(targets.values())
    .filter(isArtifactTarget)
    .sort((left, right) => right.confidence - left.confidence);
}
