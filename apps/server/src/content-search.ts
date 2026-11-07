import { workspaceContentPath } from "./project-storage.js";
import { existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  matchesSearch,
  searchExcerpt,
  type ContentSearchResponse,
  type ContentSearchResult,
} from "./search-schema.js";
import {
  openSqliteReadonly,
  MANAGED_ENGINE_DB_FILENAME,
} from "./managed-opencode-db.js";
import { resolveOpencodeDbPath } from "./opencode-db.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import {
  CORPUS_EXTENSIONS,
  extractCorpusText,
  type CorpusText,
} from "./corpus/extract.js";
import { documentMatches } from "./corpus/passages.js";
import type { DocumentPreparation } from "./document-preparation/service.js";
import { within } from "./reviews/storage.js";

const RESULT_LIMIT = 60;

export function localSessionDatabasePath(config: ServerConfig) {
  const managedPath = join(
    runtimeStorageDir(config),
    MANAGED_ENGINE_DB_FILENAME,
  );
  return !process.env.OPENCODE_DB?.trim() && existsSync(managedPath)
    ? managedPath
    : resolveOpencodeDbPath();
}

/** Read the engine's own local transcripts, including messages older than the UI's history window. */
export async function searchSessionContents(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  query: string,
  signal: AbortSignal,
): Promise<ContentSearchResponse> {
  const dbPath = localSessionDatabasePath(config);
  if (!existsSync(dbPath))
    throw new Error("The local session database is unavailable.");
  const db = await openSqliteReadonly(dbPath);
  try {
    const root =
      workspace.opencode?.directory || workspace.directory || workspace.path;
    const canonicalRoot = await realpath(root).catch(() => resolve(root));
    // Released 2.1.4 retains legacy tables, but only these native tables
    // contain new chats. Never fall back to a stale v1 transcript silently.
    const stored = (path: string) =>
      process.platform === "win32" ? path.replaceAll("\\", "/") : path;
    const sessions = db.all(
      `SELECT id,title,time_updated FROM session_v2
      WHERE directory IN (?,?) AND (time_archived IS NULL OR time_archived=0) ORDER BY time_updated DESC`,
      [stored(root), stored(canonicalRoot)],
    );
    const found = new Map<string, ContentSearchResult>();
    const add = (
      session: Record<string, unknown>,
      excerpt = "",
      messageId?: string,
    ) => {
      const id = String(session.id);
      found.set(id, {
        kind: "sessions",
        id,
        workspaceId: workspace.id,
        title: typeof session.title === "string" ? session.title : "",
        excerpt: searchExcerpt(excerpt, query),
        updatedAt: Number(session.time_updated),
        ...(messageId ? { messageId } : {}),
      });
    };
    for (const session of sessions) {
      if (
        matchesSearch(
          typeof session.title === "string" ? session.title : "",
          query,
        )
      )
        add(session);
      if (found.size > RESULT_LIMIT) break;
    }
    let scanned = 0;
    for (const session of sessions) {
      signal.throwIfAborted();
      if (found.size > RESULT_LIMIT) break;
      if (found.has(String(session.id))) continue;
      // Stream complete public prose, excluding synthetic messages, tool
      // results and reasoning. Native user.text includes model reminders;
      // only the explicitly attested visibleText is searchable when present.
      const parts = db.iterate(
        `SELECT m.id AS message_id,
        CASE WHEN m.type='user' THEN
          CASE WHEN json_type(m.data,'$.metadata.legalworkPrompt.visibleText')='text'
            THEN json_extract(m.data,'$.metadata.legalworkPrompt.visibleText')
            ELSE json_extract(m.data,'$.text') END
        ELSE (SELECT group_concat(json_extract(c.value,'$.text'),char(10))
          FROM json_each(m.data,'$.content') c
          WHERE json_extract(c.value,'$.type')='text') END AS text
        FROM session_message m WHERE m.session_id=? AND m.type IN ('user','assistant') ORDER BY m.seq DESC`,
        [String(session.id)],
      );
      for (const part of parts) {
        if (++scanned % 200 === 0) {
          await setImmediate();
          signal.throwIfAborted();
        }
        if (typeof part.text === "string" && matchesSearch(part.text, query)) {
          add(session, part.text, String(part.message_id));
          break;
        }
      }
    }
    return {
      items: [...found.values()].slice(0, RESULT_LIMIT),
      limited: found.size > RESULT_LIMIT,
    };
  } finally {
    db.close();
  }
}

// Background preparation survives a changed query. Only two files per server
// are prepared at once; polling reuses both these results and the OCR disk cache.
type FileEntry = {
  revision: string;
  value?: CorpusText;
  error?: string;
  pending: boolean;
  touched: number;
  retryRequested?: boolean;
};
const caches = new WeakMap<DocumentPreparation, Map<string, FileEntry>>();
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);
function documentEntry(
  preparation: DocumentPreparation,
  root: string,
  path: string,
  revision: string,
  retry: boolean,
) {
  let cache = caches.get(preparation);
  if (!cache) {
    cache = new Map();
    caches.set(preparation, cache);
  }
  const key = join(root, path);
  const prior = cache.get(key);
  if (prior?.revision === revision) {
    prior.touched = Date.now();
    if (retry && !prior.pending && (prior.error || !prior.value?.complete))
      prior.retryRequested = true;
    if (prior.pending || !prior.retryRequested) return prior;
  }
  if ([...cache.values()].filter((entry) => entry.pending).length >= 2) return;
  let characters = [...cache.values()].reduce(
    (total, entry) => total + (entry.value?.text.length ?? 0),
    0,
  );
  for (const [id, entry] of [...cache.entries()].sort(
    (a, b) => a[1].touched - b[1].touched,
  )) {
    if (cache.size < 2000 && characters <= 24_000_000) break;
    if (entry.pending) continue;
    cache.delete(id);
    characters -= entry.value?.text.length ?? 0;
  }
  const entry: FileEntry = { revision, pending: true, touched: Date.now() };
  cache.set(key, entry);
  void extractCorpusText(
    root,
    path,
    preparation,
    AbortSignal.timeout(5 * 60_000),
    {
      retry:
        retry ||
        (prior?.revision === revision && prior.retryRequested === true),
    },
  )
    .then(
      (value) => {
        entry.value = value;
      },
      (error) => {
        entry.error =
          error instanceof Error ? error.message : "Could not read this file.";
      },
    )
    .finally(() => {
      entry.pending = false;
    });
  return entry;
}

export async function searchFileContents(
  workspace: WorkspaceInfo,
  query: string,
  signal: AbortSignal,
  preparation: DocumentPreparation,
  retry = false,
): Promise<ContentSearchResponse> {
  const root = await realpath(workspaceContentPath(workspace));
  const items: ContentSearchResult[] = [],
    issues: Array<{ path: string; reason: string }> = [];
  let visited = 0,
    skipped = 0,
    incomplete = 0,
    preparing = 0,
    limited = false;
  const deadline = Date.now() + 2500;
  const issue = (path: string, reason: string) => {
    if (issues.length < 20) issues.push({ path, reason });
  };
  async function visit(directory: string): Promise<void> {
    signal.throwIfAborted();
    const entries = await opendir(directory);
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (++visited > 20_000 || Date.now() > deadline) {
        limited = true;
        break;
      }
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name))
          await visit(path).catch((error) => {
            if (signal.aborted) throw error;
            skipped++;
          });
        if (limited) break;
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, path).split("\\").join("/");
      try {
        const canonicalPath = await realpath(path);
        if (!within(root, canonicalPath)) continue;
        const info = await stat(canonicalPath);
        const nameMatch = matchesSearch(relativePath, query);
        let source: CorpusText | undefined;
        if (CORPUS_EXTENSIONS.has(extname(path).toLowerCase())) {
          if (info.size > 64 * 1024 * 1024) {
            skipped++;
            issue(relativePath, "File exceeds the 64 MiB preparation limit.");
          } else {
            const document = documentEntry(
              preparation,
              root,
              relativePath,
              `${info.mtimeMs}:${info.ctimeMs}:${info.size}`,
              retry,
            );
            if (!document || document.pending) preparing++;
            else if (document.error) {
              skipped++;
              issue(relativePath, document.error);
            } else if (document.value) {
              source = document.value;
              if (!source.complete) {
                incomplete++;
                issue(
                  relativePath,
                  source.issue ?? "Some regions could not be read.",
                );
              }
            }
          }
        } else {
          skipped++;
          issue(
            relativePath,
            "Content search is unavailable for this file type. Its name is still searchable.",
          );
        }
        const matches = source
          ? documentMatches(source, relativePath, query)
          : { sources: [], sourcesLimited: false };
        if (!nameMatch && !matches.sources.length) continue;
        items.push({
          kind: "files",
          id: relativePath,
          workspaceId: workspace.id,
          path: relativePath,
          title: basename(path),
          excerpt: matches.sources[0]?.quote ?? relativePath,
          updatedAt: info.mtimeMs,
          ...matches,
          incomplete: source ? !source.complete : undefined,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        skipped++;
        issue(
          relativePath,
          error instanceof Error ? error.message : "Could not read this file.",
        );
      }
    }
  }
  await visit(root);
  return {
    items: items.slice(0, RESULT_LIMIT),
    limited: limited || items.length > RESULT_LIMIT,
    skipped,
    preparing,
    incomplete,
    issues,
    retryable: incomplete > 0 || skipped > 0,
  };
}
