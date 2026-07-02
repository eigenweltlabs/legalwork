/**
 * Minimal Office.js bridge for the Word task pane.
 *
 * office.js is loaded from the Microsoft CDN in taskpane.html; the globals
 * are typed structurally here (only the members we use) instead of pulling
 * in @types/office-js for a handful of calls. Everything degrades cleanly
 * when the page runs outside of Word (e.g. opened in a plain browser).
 */

type OfficeHostInfo = { host?: unknown; platform?: unknown };

type OfficeNamespace = {
  onReady: (callback?: (info: OfficeHostInfo) => void) => Promise<OfficeHostInfo> | void;
};

type WordRange = {
  text: string;
  load: (properties: string) => void;
  insertText: (text: string, insertLocation: string) => void;
};

type WordBody = {
  text: string;
  load: (properties: string) => void;
};

type WordRunContext = {
  document: {
    body: WordBody;
    getSelection: () => WordRange;
  };
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

/** True when running inside Word with the Word JavaScript API available. */
export function isWordDocumentHost(): boolean {
  return readyHost?.toLowerCase() === "word" && Boolean(officeGlobals().word);
}

function requireWord(): WordNamespace {
  const { word } = officeGlobals();
  if (!word) {
    throw new Error("The Word JavaScript API is not available in this context.");
  }
  return word;
}

export async function readSelectionText(): Promise<string> {
  return requireWord().run(async (context) => {
    const selection = context.document.getSelection();
    selection.load("text");
    await context.sync();
    return selection.text ?? "";
  });
}

export async function readDocumentText(): Promise<string> {
  return requireWord().run(async (context) => {
    const body = context.document.body;
    body.load("text");
    await context.sync();
    return body.text ?? "";
  });
}

/** Replace the current selection (or insert at the cursor) with plain text. */
export async function insertTextAtSelection(text: string): Promise<void> {
  await requireWord().run(async (context) => {
    context.document.getSelection().insertText(text, "Replace");
    await context.sync();
  });
}
