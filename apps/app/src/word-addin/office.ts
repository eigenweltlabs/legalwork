/**
 * Minimal Office.js bridge for the Word task pane.
 *
 * office.js is loaded from the Microsoft CDN in taskpane.html; the globals
 * are typed structurally here (only the members we use) instead of pulling
 * in @types/office-js. Everything degrades cleanly when the page runs
 * outside of Word (e.g. opened in a plain browser).
 */

type OfficeHostInfo = { host?: unknown; platform?: unknown };

type OfficeNamespace = {
  onReady: (callback?: (info: OfficeHostInfo) => void) => Promise<OfficeHostInfo> | void;
  context?: {
    requirements?: { isSetSupported?: (name: string, version?: string) => boolean };
    document?: { url?: string | null };
  };
};

export type WordParagraph = {
  text: string;
  load: (properties: string) => void;
};

export type WordParagraphCollection = {
  items: WordParagraph[];
  load: (properties: string) => void;
};

export type WordRange = {
  text: string;
  load: (properties: string) => void;
  insertText: (text: string, insertLocation: string) => WordRange;
  insertComment: (commentText: string) => unknown;
  delete: () => void;
  paragraphs: WordParagraphCollection;
};

export type WordRangeCollection = {
  items: WordRange[];
  load: (properties: string) => void;
};

export type WordSearchOptions = {
  matchCase?: boolean;
  matchWholeWord?: boolean;
  matchWildcards?: boolean;
};

export type WordBody = {
  text: string;
  load: (properties: string) => void;
  insertText: (text: string, insertLocation: string) => WordRange;
  search: (searchText: string, options?: WordSearchOptions) => WordRangeCollection;
};

export type WordDocumentProxy = {
  body: WordBody;
  getSelection: () => WordRange;
  changeTrackingMode: string;
  load: (properties: string) => void;
};

export type WordRunContext = {
  document: WordDocumentProxy;
  sync: () => Promise<void>;
};

type WordNamespace = {
  run: <T>(batch: (context: WordRunContext) => Promise<T>) => Promise<T>;
};

function officeGlobals(): { office?: OfficeNamespace; word?: WordNamespace } {
  const scope = window as unknown as { Office?: OfficeNamespace; Word?: WordNamespace };
  return { office: scope.Office, word: scope.Word };
}

let readyHost: string | null = null;

/**
 * Wait for Office.js initialization. Resolves immediately (and reports
 * "not in Office") when office.js is absent or never becomes ready --
 * the pane then still works as a plain LegalWork web client.
 */
export async function officeReady(timeoutMs = 5000): Promise<boolean> {
  const { office } = officeGlobals();
  if (!office?.onReady) return false;
  try {
    const info = await Promise.race([
      Promise.resolve(office.onReady()).then((value) => value ?? {}),
      new Promise<OfficeHostInfo>((resolve) => window.setTimeout(() => resolve({}), timeoutMs)),
    ]);
    readyHost = info && info.host != null ? String(info.host) : null;
  } catch {
    readyHost = null;
  }
  return readyHost != null;
}

/** Lowercased Office host name ("word", "excel", ...) once ready, else null. */
export function officeHostName(): string | null {
  return readyHost ? readyHost.toLowerCase() : null;
}

/** True when running inside Word with the Word JavaScript API available. */
export function isWordDocumentHost(): boolean {
  return officeHostName() === "word" && Boolean(officeGlobals().word);
}

/** Check any Office requirement set, e.g. ("ExcelApi", "1.10"). */
export function isOfficeApiSupported(setName: string, version: string): boolean {
  const supported = officeGlobals().office?.context?.requirements?.isSetSupported;
  try {
    return supported ? supported(setName, version) : false;
  } catch {
    return false;
  }
}

/** Check a Word requirement set, e.g. isWordApiSupported("1.4") for tracking/comments. */
export function isWordApiSupported(version: string): boolean {
  return isOfficeApiSupported("WordApi", version);
}

/** URL/path of the open document, when the host exposes it. */
export function getDocumentUrl(): string | null {
  const url = officeGlobals().office?.context?.document?.url;
  return typeof url === "string" && url.trim() ? url : null;
}

function requireWord(): WordNamespace {
  const { word } = officeGlobals();
  if (!word) {
    throw new Error("The Word JavaScript API is not available in this context.");
  }
  return word;
}

/** Run a Word.run batch. Throws outside of Word. */
export function wordRun<T>(batch: (context: WordRunContext) => Promise<T>): Promise<T> {
  return requireWord().run(batch);
}

export async function readSelectionText(): Promise<string> {
  return wordRun(async (context) => {
    const selection = context.document.getSelection();
    selection.load("text");
    await context.sync();
    return selection.text ?? "";
  });
}

export async function readDocumentText(): Promise<string> {
  return wordRun(async (context) => {
    const body = context.document.body;
    body.load("text");
    await context.sync();
    return body.text ?? "";
  });
}

/** Replace the current selection (or insert at the cursor) with plain text. */
export async function insertTextAtSelection(text: string): Promise<void> {
  await wordRun(async (context) => {
    context.document.getSelection().insertText(text, "Replace");
    await context.sync();
  });
}
