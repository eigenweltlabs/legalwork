import JSZip from "jszip";
import { canRenderFont, loadFonts, setGoogleFontsEnabled } from "@eigenpal/docx-editor-core";

import { BUNDLED_OFFICE_FONTS } from "./office-font-families";

/**
 * Fonts a document asks for that this machine cannot render.
 *
 * The editor's own Google Fonts lookup is off (see artifact-docx-editor.tsx):
 * resolving a document's fonts against Google would disclose the typefaces
 * inside a client's file. office-fonts.css covers the Office families, so what
 * is left here is the case the old code would have fetched — a font that is
 * neither installed, nor embedded in the document, nor one we bundle. Rather
 * than silently substituting, the editor asks whether to fetch it.
 */

/** localStorage key holding the per-family decisions, as {family: boolean}. */
const STORAGE_KEY = "legalwork.docx.font-consent";

type Decisions = Record<string, boolean>;

function readDecisions(): Decisions {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Decisions = {};
    for (const [family, allowed] of Object.entries(parsed)) {
      if (typeof allowed === "boolean") out[family] = allowed;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDecisions(next: Decisions) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A firm can lock down storage; the prompt just reappears next time.
  }
}

/** Remember a choice so the same font is not queried on every open. */
export function rememberFontDecision(families: string[], allowed: boolean) {
  const decisions = readDecisions();
  for (const family of families) decisions[family] = allowed;
  writeDecisions(decisions);
}

/** Families the user has already answered for, either way. */
function decided(): Decisions {
  return readDecisions();
}

const FONT_ATTR = /w:(?:ascii|hAnsi|cs)="([^"]+)"/g;
/** Word writes theme references as +mn-lt / +mj-lt rather than a family name. */
const THEME_REFERENCE = /^[+@]/;

/** Every font family named anywhere in the document package. */
async function documentFontFamilies(buffer: ArrayBuffer): Promise<Set<string>> {
  const families = new Set<string>();
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter(
    (name) => name.startsWith("word/") && name.endsWith(".xml"),
  );
  for (const name of parts) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    for (const match of xml.matchAll(FONT_ATTR)) {
      const family = match[1].trim();
      if (family && !THEME_REFERENCE.test(family)) families.add(family);
    }
  }
  return families;
}

/**
 * Which of a document's fonts would need fetching, and have not been answered
 * for yet. Empty when everything renders locally — the common case, since the
 * Office families are bundled.
 */
export async function unresolvedDocumentFonts(buffer: ArrayBuffer): Promise<string[]> {
  let families: Set<string>;
  try {
    families = await documentFontFamilies(buffer);
  } catch {
    return []; // Unreadable package: the editor surfaces its own error.
  }

  const answered = decided();
  return [...families]
    .filter((family) => !BUNDLED_OFFICE_FONTS.has(family))
    .filter((family) => !(family in answered))
    .filter((family) => !canRenderFont(family))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch these families from Google Fonts, once, with the lookup re-enabled for
 * the duration. The flag is page-global and defaults to off, so it is restored
 * immediately: consent covers the fonts the user was shown, not the next
 * document that happens to open.
 */
export async function loadFontsFromGoogle(families: string[]): Promise<void> {
  setGoogleFontsEnabled(true);
  try {
    await loadFonts(families);
  } finally {
    setGoogleFontsEnabled(false);
  }
}
