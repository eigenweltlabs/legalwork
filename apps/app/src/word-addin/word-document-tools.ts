/**
 * Office.js implementations of the agent's word_* tools.
 *
 * Contract (mirrored by the legalwork-word-tools OpenCode plugin):
 * - Edits are anchor-based: the model supplies exact text copied from the
 *   document; character offsets would drift while the user types.
 * - Every mutation runs with Word change tracking forced to TrackAll, so
 *   agent edits are always reviewable redlines. If the host Word version
 *   cannot control tracking (WordApi < 1.4), edits are refused entirely --
 *   silent modifications are never acceptable for legal documents.
 * - Handlers throw Error with a model-readable message; the relay client
 *   converts that into { ok: false, error } for the tool result.
 */
import {
  getDocumentUrl,
  isWordApiSupported,
  readSelectionText,
  wordRun,
  type WordRange,
  type WordRunContext,
} from "./office";
import { runOfficeCode } from "./office-run-code";

export type WordToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const DEFAULT_READ_CHARS = 30_000;
const MAX_ANCHOR_CHARS = 240;
const PARAGRAPH_CONTEXT_CHARS = 500;

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireAnchor(args: Record<string, unknown>): string {
  const anchor = stringArg(args, "anchor")?.trim();
  if (!anchor) throw new Error("anchor is required and must be exact text from the document.");
  if (anchor.length > MAX_ANCHOR_CHARS) {
    throw new Error(`anchor is too long (${anchor.length} chars). Use a shorter distinctive snippet (max ${MAX_ANCHOR_CHARS}).`);
  }
  if (/[\r\n]/.test(anchor)) {
    throw new Error("anchor must not span paragraphs. Use a snippet from within a single paragraph.");
  }
  return anchor;
}

async function findAnchorRanges(context: WordRunContext, anchor: string): Promise<WordRange[]> {
  const results = context.document.body.search(anchor, { matchCase: true, matchWildcards: false });
  results.load("text");
  await context.sync();
  return results.items;
}

function pickAnchorRange(ranges: WordRange[], occurrence: number | undefined, anchor: string): { range: WordRange; index: number } {
  if (ranges.length === 0) {
    throw new Error(
      `Anchor not found: "${anchor}". Read the document again and copy the text verbatim (matching is case-sensitive).`,
    );
  }
  if (occurrence !== undefined) {
    if (occurrence < 1 || occurrence > ranges.length) {
      throw new Error(`occurrence ${occurrence} is out of range: the anchor matches ${ranges.length} time(s).`);
    }
    return { range: ranges[occurrence - 1]!, index: occurrence - 1 };
  }
  if (ranges.length > 1) {
    throw new Error(
      `The anchor matches ${ranges.length} places. Pass occurrence (1-${ranges.length}) or use word_search to inspect the matches.`,
    );
  }
  return { range: ranges[0]!, index: 0 };
}

/**
 * Run a mutation with change tracking forced on, restoring the user's
 * previous tracking mode afterwards (revisions persist once made).
 */
async function withTrackedChanges(context: WordRunContext, mutate: () => void): Promise<void> {
  if (!isWordApiSupported("1.4")) {
    throw new Error(
      "This Word version does not support controlling tracked changes from add-ins (requires WordApi 1.4). Document edits are disabled for safety — the user can update Word/Microsoft 365 to enable them.",
    );
  }
  const document = context.document;
  document.load("changeTrackingMode");
  await context.sync();
  const originalMode = document.changeTrackingMode;

  if (originalMode !== "TrackAll") {
    document.changeTrackingMode = "TrackAll";
    await context.sync();
  }
  try {
    mutate();
    await context.sync();
  } finally {
    if (originalMode !== "TrackAll") {
      document.changeTrackingMode = originalMode;
      await context.sync();
    }
  }
}

async function readDocument(args: Record<string, unknown>): Promise<unknown> {
  const maxChars = Math.min(Math.max(numberArg(args, "max_chars") ?? DEFAULT_READ_CHARS, 1_000), 200_000);
  return wordRun(async (context) => {
    const body = context.document.body;
    body.load("text");
    const trackingSupported = isWordApiSupported("1.4");
    if (trackingSupported) context.document.load("changeTrackingMode");
    await context.sync();
    const text = body.text ?? "";
    return {
      documentUrl: getDocumentUrl(),
      totalChars: text.length,
      truncated: text.length > maxChars,
      changeTrackingMode: trackingSupported ? context.document.changeTrackingMode : "unsupported",
      editingSupported: trackingSupported,
      text: text.slice(0, maxChars),
    };
  });
}

async function readSelection(): Promise<unknown> {
  const text = await readSelectionText();
  return { text, empty: text.trim().length === 0 };
}

async function search(args: Record<string, unknown>): Promise<unknown> {
  const query = stringArg(args, "query")?.trim();
  if (!query) throw new Error("query is required.");
  if (query.length > MAX_ANCHOR_CHARS) throw new Error(`query is too long (max ${MAX_ANCHOR_CHARS} chars).`);
  const matchCase = args.match_case !== false;
  const maxResults = Math.min(Math.max(numberArg(args, "max_results") ?? 10, 1), 50);

  return wordRun(async (context) => {
    const results = context.document.body.search(query, { matchCase, matchWildcards: false });
    results.load("text");
    await context.sync();

    const slice = results.items.slice(0, maxResults);
    for (const range of slice) {
      range.paragraphs.load("text");
    }
    await context.sync();

    return {
      total: results.items.length,
      returned: slice.length,
      matches: slice.map((range, index) => ({
        occurrence: index + 1,
        text: range.text,
        paragraph: range.paragraphs.items[0]?.text?.slice(0, PARAGRAPH_CONTEXT_CHARS) ?? "",
      })),
    };
  });
}

async function replaceText(args: Record<string, unknown>): Promise<unknown> {
  const anchor = requireAnchor(args);
  const replacement = stringArg(args, "replacement");
  if (replacement === undefined) throw new Error("replacement is required (empty string deletes the anchor text).");
  const occurrence = numberArg(args, "occurrence");

  return wordRun(async (context) => {
    const ranges = await findAnchorRanges(context, anchor);
    const { range, index } = pickAnchorRange(ranges, occurrence, anchor);
    await withTrackedChanges(context, () => {
      if (replacement === "") {
        range.delete();
      } else {
        range.insertText(replacement, "Replace");
      }
    });
    return {
      applied: true,
      trackedChange: true,
      action: replacement === "" ? "deleted" : "replaced",
      matches: ranges.length,
      occurrence: index + 1,
    };
  });
}

async function insertText(args: Record<string, unknown>): Promise<unknown> {
  const location = stringArg(args, "location");
  const text = stringArg(args, "text");
  if (!text) throw new Error("text is required.");

  return wordRun(async (context) => {
    if (location === "document_start" || location === "document_end") {
      await withTrackedChanges(context, () => {
        context.document.body.insertText(text, location === "document_start" ? "Start" : "End");
      });
      return { applied: true, trackedChange: true, location };
    }

    if (location === "before_anchor" || location === "after_anchor") {
      const anchor = requireAnchor(args);
      const ranges = await findAnchorRanges(context, anchor);
      const { range, index } = pickAnchorRange(ranges, numberArg(args, "occurrence"), anchor);
      await withTrackedChanges(context, () => {
        range.insertText(text, location === "before_anchor" ? "Before" : "After");
      });
      return { applied: true, trackedChange: true, location, matches: ranges.length, occurrence: index + 1 };
    }

    throw new Error("location must be one of document_start, document_end, before_anchor, after_anchor.");
  });
}

async function addComment(args: Record<string, unknown>): Promise<unknown> {
  const anchor = requireAnchor(args);
  const comment = stringArg(args, "comment")?.trim();
  if (!comment) throw new Error("comment is required.");
  if (!isWordApiSupported("1.4")) {
    throw new Error("This Word version does not support inserting comments from add-ins (requires WordApi 1.4).");
  }

  return wordRun(async (context) => {
    const ranges = await findAnchorRanges(context, anchor);
    const { range, index } = pickAnchorRange(ranges, numberArg(args, "occurrence"), anchor);
    range.insertComment(comment);
    await context.sync();
    return { applied: true, matches: ranges.length, occurrence: index + 1 };
  });
}

export function createWordToolHandlers(): Record<string, WordToolHandler> {
  return {
    word_read_document: readDocument,
    word_read_selection: readSelection,
    word_search: search,
    word_replace_text: replaceText,
    word_insert_text: insertText,
    word_add_comment: addComment,
    word_run_code: (args) => runOfficeCode("word", args),
  };
}
