/**
 * Office.js implementations of the agent's word_* tools.
 *
 * Contract (mirrored by the legalwork-word-tools OpenCode plugin):
 * - Edits are anchor-based: the model supplies exact text copied from the
 *   document; character offsets would drift while the user types.
 * - Every mutation runs with Word change tracking forced to TrackAll, so
 *   agent edits are always reviewable redlines. If the host Word version
 *   cannot control tracking (WordApi < 1.4), the redline is synthesized
 *   instead: the edit is inserted as OOXML w:ins/w:del revision markup
 *   (insertOoxml, WordApi 1.1), which Word treats as a normal tracked
 *   change attributed to REVISION_AUTHOR. Only if the host rejects that
 *   package does the edit apply untracked, flagged trackedChange: false
 *   with a warning the agent must relay. Comments genuinely do not exist
 *   below 1.4 and keep failing with a diagnostic.
 * - Handlers throw Error with a model-readable message; the relay client
 *   converts that into { ok: false, error } for the tool result.
 */
import {
  getDocumentUrl,
  isWordApiSupported,
  untrackedEditWarning,
  wordApiDiagnostic,
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
 * Requires WordApi 1.4; callers below that go through applyTracked's
 * revision-markup path instead.
 */
async function withTrackedChanges(context: WordRunContext, mutate: () => void): Promise<void> {
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

/** Author shown on synthesized revisions in Word's Review ribbon. */
export const REVISION_AUTHOR = "LegalWork";

let revisionIdCounter = 0;

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A single run; newlines become w:br (anchors are single-paragraph by contract). */
function revisionRun(text: string, kind: "ins" | "del"): string {
  const tag = kind === "del" ? "w:delText" : "w:t";
  const content = text
    .split(/\r\n|\r|\n/)
    .map((line) => `<${tag} xml:space="preserve">${xmlEscape(line)}</${tag}>`)
    .join("<w:br/>");
  return `<w:r>${content}</w:r>`;
}

/**
 * Flat-OPC package holding one paragraph of w:ins/w:del revision runs.
 * Range.insertOoxml (WordApi 1.1) splices a single-paragraph package into
 * the target paragraph inline, and Word treats the markup as real tracked
 * changes: they show up in the Review ribbon, attributable and
 * accept/rejectable, no WordApi 1.4 needed.
 */
export function revisionOoxml(parts: Array<{ kind: "ins" | "del"; text: string }>): string {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const revisions = parts
    .filter((part) => part.text.length > 0)
    .map(
      (part) =>
        `<w:${part.kind} w:id="${++revisionIdCounter}" w:author="${REVISION_AUTHOR}" w:date="${date}">` +
        `${revisionRun(part.text, part.kind)}</w:${part.kind}>`,
    )
    .join("");
  return (
    `<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage">` +
    `<pkg:part pkg:name="/_rels/.rels" pkg:contentType="application/vnd.openxmlformats-package.relationships+xml">` +
    `<pkg:xmlData>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/>` +
    `</Relationships>` +
    `</pkg:xmlData>` +
    `</pkg:part>` +
    `<pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml">` +
    `<pkg:xmlData>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body><w:p>${revisions}</w:p></w:body>` +
    `</w:document>` +
    `</pkg:xmlData>` +
    `</pkg:part>` +
    `</pkg:package>`
  );
}

type EditOutcome = { trackedChange: boolean; method?: "revision-markup"; warning?: string };

/**
 * The tracked-edit ladder: native tracking (WordApi 1.4) -> synthesized
 * w:ins/w:del revision markup -> plain untracked edit as last resort,
 * flagged with a warning the agent relays to the user.
 */
async function applyTracked(
  context: WordRunContext,
  mutate: () => void,
  insertRevision: () => void,
): Promise<EditOutcome> {
  if (isWordApiSupported("1.4")) {
    await withTrackedChanges(context, mutate);
    return { trackedChange: true };
  }
  try {
    insertRevision();
    await context.sync();
    return { trackedChange: true, method: "revision-markup" };
  } catch {
    mutate();
    await context.sync();
    return { trackedChange: false, warning: untrackedEditWarning() };
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
      editingSupported: true,
      trackedEditingSupported: trackingSupported,
      ...(trackingSupported
        ? {}
        : {
            warning:
              "This Word version lacks WordApi 1.4: edits become redlines via synthesized revision markup " +
              `(author "${REVISION_AUTHOR}"), and comments are unavailable. ${wordApiDiagnostic()}`,
          }),
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
    const outcome = await applyTracked(
      context,
      () => {
        if (replacement === "") {
          range.delete();
        } else {
          range.insertText(replacement, "Replace");
        }
      },
      () =>
        range.insertOoxml(
          revisionOoxml([
            { kind: "del", text: range.text || anchor },
            { kind: "ins", text: replacement },
          ]),
          "Replace",
        ),
    );
    return {
      applied: true,
      ...outcome,
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
      const wordLocation = location === "document_start" ? "Start" : "End";
      const outcome = await applyTracked(
        context,
        () => context.document.body.insertText(text, wordLocation),
        () => context.document.body.insertOoxml(revisionOoxml([{ kind: "ins", text }]), wordLocation),
      );
      return { applied: true, ...outcome, location };
    }

    if (location === "before_anchor" || location === "after_anchor") {
      const anchor = requireAnchor(args);
      const ranges = await findAnchorRanges(context, anchor);
      const { range, index } = pickAnchorRange(ranges, numberArg(args, "occurrence"), anchor);
      const wordLocation = location === "before_anchor" ? "Before" : "After";
      const outcome = await applyTracked(
        context,
        () => range.insertText(text, wordLocation),
        () => range.insertOoxml(revisionOoxml([{ kind: "ins", text }]), wordLocation),
      );
      return {
        applied: true,
        ...outcome,
        location,
        matches: ranges.length,
        occurrence: index + 1,
      };
    }

    throw new Error("location must be one of document_start, document_end, before_anchor, after_anchor.");
  });
}

async function addComment(args: Record<string, unknown>): Promise<unknown> {
  const anchor = requireAnchor(args);
  const comment = stringArg(args, "comment")?.trim();
  if (!comment) throw new Error("comment is required.");
  if (!isWordApiSupported("1.4")) {
    throw new Error(
      "Comments are unavailable on this Word version (requires WordApi 1.4) — put the rationale in the chat reply " +
        `instead. ${wordApiDiagnostic()}`,
    );
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
