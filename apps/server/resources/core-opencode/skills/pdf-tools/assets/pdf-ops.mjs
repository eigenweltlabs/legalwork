/**
 * pdf-ops — core PDF operations behind the pdf-tools skill (inspect / annotate /
 * fill-form / sign). Pure functions over PDF bytes: no file IO here — the thin
 * CLI wrapper (pdf-agent.mjs) reads/writes files, so this module is directly
 * importable in tests.
 *
 * Self-contained: imports the vendored ./vendor/pdf-lib.mjs (pdf-lib, MIT — pure
 * JS, no native deps), so it runs in any seeded workspace with NO node_modules.
 *
 * Conventions (documented in SKILL.md):
 * - Pages are 1-based.
 * - Coordinates are PDF points (1/72 inch) with the ORIGIN AT THE BOTTOM-LEFT
 *   of the page; (x, y) is the bottom-left corner of whatever is placed.
 */

import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  StandardFonts,
  rgb,
} from "./vendor/pdf-lib.mjs";

/** Expected, user-explainable failures (bad input, bad page, bad field...). */
export class PdfOpsError extends Error {}

function fail(message) {
  throw new PdfOpsError(message);
}

async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`could not read the PDF (${reason}). Is the file a valid, unencrypted PDF?`);
  }
}

/** 1-based page lookup with a helpful out-of-range message. */
function getPage(doc, pageNumber, what) {
  const count = doc.getPageCount();
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > count) {
    fail(`${what}: page ${pageNumber} is out of range — this PDF has ${count} page${count === 1 ? "" : "s"} (pages are 1-based)`);
  }
  return doc.getPage(pageNumber - 1);
}

function parseHexColor(value, what) {
  const hex = String(value).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) fail(`${what}: invalid color "${value}" — use "#RRGGBB"`);
  return rgb(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  );
}

function requireNumber(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${what} must be a number (PDF points, origin bottom-left)`);
  return value;
}

/** Standard fonts only encode WinAnsi — swap anything else for "?" instead of crashing. */
function encodable(font, text) {
  let out = "";
  for (const ch of text) {
    try {
      font.widthOfTextAtSize(ch, 10);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

/** Greedy word wrap; a single over-long word stays on its own line. */
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = "";
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

// ---------- inspect ----------

function fieldKind(field) {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFDropdown) return "dropdown";
  if (field instanceof PDFOptionList) return "option-list";
  if (field instanceof PDFRadioGroup) return "radio-group";
  return "other";
}

function describeField(field) {
  const info = { name: field.getName(), type: fieldKind(field) };
  if (field instanceof PDFTextField) info.value = field.getText() ?? "";
  else if (field instanceof PDFCheckBox) info.checked = field.isChecked();
  else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    info.options = field.getOptions();
    info.value = field.getSelected();
  } else if (field instanceof PDFRadioGroup) {
    info.options = field.getOptions();
    info.value = field.getSelected();
  }
  return info;
}

/** Page sizes (points) + every AcroForm field with its name/type/value/options. */
export async function inspectPdf(bytes) {
  const doc = await loadPdf(bytes);
  return {
    pageCount: doc.getPageCount(),
    pages: doc.getPages().map((page, i) => {
      const { width, height } = page.getSize();
      return { page: i + 1, width, height };
    }),
    fields: doc.getForm().getFields().map(describeField),
  };
}

// ---------- annotate ----------

const NOTE_FONT_SIZE = 10;
const NOTE_PADDING = 6;

function drawNote(page, font, annotation, what) {
  const text = typeof annotation.text === "string" ? annotation.text.trim() : "";
  if (!text) fail(`${what}: a note needs non-empty "text"`);
  const x = requireNumber(annotation.x, `${what}: "x"`);
  const y = requireNumber(annotation.y, `${what}: "y"`);
  const size = NOTE_FONT_SIZE;
  const lineHeight = size * 1.35;
  const maxWidth = Math.max(60, Math.min(260, page.getSize().width - x - 2 * NOTE_PADDING));
  const lines = wrapText(encodable(font, text), font, size, maxWidth);
  const boxWidth = Math.max(...lines.map((line) => font.widthOfTextAtSize(line, size))) + 2 * NOTE_PADDING;
  const boxHeight = lines.length * lineHeight + 2 * NOTE_PADDING;
  page.drawRectangle({
    x,
    y,
    width: boxWidth,
    height: boxHeight,
    color: parseHexColor(annotation.color ?? "#FFF59D", what),
    borderColor: rgb(0.72, 0.6, 0.05),
    borderWidth: 0.75,
    opacity: 0.95,
  });
  lines.forEach((line, i) => {
    page.drawText(line, {
      x: x + NOTE_PADDING,
      y: y + boxHeight - NOTE_PADDING - size * 0.85 - i * lineHeight,
      size,
      font,
      color: rgb(0.2, 0.16, 0),
    });
  });
}

function drawHighlight(page, annotation, what) {
  const x = requireNumber(annotation.x, `${what}: "x"`);
  const y = requireNumber(annotation.y, `${what}: "y"`);
  const width = requireNumber(annotation.width, `${what}: "width"`);
  const height = typeof annotation.height === "number" && Number.isFinite(annotation.height) ? annotation.height : 14;
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: parseHexColor(annotation.color ?? "#FFEB3B", what),
    opacity: 0.35,
  });
}

/**
 * plan = { annotations: [
 *   { type: "note",      page, x, y, text, color? },
 *   { type: "highlight", page, x, y, width, height?, color? },
 * ] }
 * Returns { bytes, notes, highlights }.
 */
export async function annotatePdf(bytes, plan) {
  const annotations = plan && Array.isArray(plan.annotations) ? plan.annotations : null;
  if (!annotations || annotations.length === 0) fail('the plan must be JSON with a non-empty "annotations" array');
  const doc = await loadPdf(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let notes = 0;
  let highlights = 0;
  annotations.forEach((annotation, i) => {
    const what = `annotations[${i}]`;
    const page = getPage(doc, annotation.page ?? 1, what);
    if (annotation.type === "note") {
      drawNote(page, font, annotation, what);
      notes += 1;
    } else if (annotation.type === "highlight") {
      drawHighlight(page, annotation, what);
      highlights += 1;
    } else {
      fail(`${what}: unknown "type" "${annotation.type}" — use "note" or "highlight"`);
    }
  });
  return { bytes: await doc.save(), notes, highlights };
}

// ---------- fill-form ----------

const CHECKED_WORDS = new Set(["true", "yes", "on", "checked", "x", "1"]);

function isChecked(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return CHECKED_WORDS.has(String(value).trim().toLowerCase());
}

/**
 * data = { "field name": value, ... }. Returns { bytes, filled, skipped } where
 * skipped = [{ field, reason }] — unknown names and invalid options are reported,
 * never silently dropped.
 */
export async function fillFormFields(bytes, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail('the fill data must be a JSON object of { "fieldName": value }');
  }
  const entries = Object.entries(data);
  if (entries.length === 0) fail("the fill data has no fields — nothing to fill");
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const known = new Map(form.getFields().map((field) => [field.getName(), field]));
  const filled = [];
  const skipped = [];
  for (const [name, value] of entries) {
    const field = known.get(name);
    if (!field) {
      skipped.push({ field: name, reason: "no form field with this name — run inspect to list the exact field names" });
      continue;
    }
    try {
      if (field instanceof PDFTextField) {
        field.setText(value === null || value === undefined ? "" : String(value));
      } else if (field instanceof PDFCheckBox) {
        if (isChecked(value)) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        const option = String(value);
        if (!field.getOptions().includes(option)) {
          skipped.push({ field: name, reason: `"${option}" is not one of the options: ${field.getOptions().join(", ")}` });
          continue;
        }
        field.select(option);
      } else {
        skipped.push({ field: name, reason: `cannot fill a "${fieldKind(field)}" field` });
        continue;
      }
      filled.push(name);
    } catch (error) {
      skipped.push({ field: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
  return { bytes: await doc.save(), filled, skipped };
}

// ---------- sign ----------

/**
 * options = { name, date?, page?, x?, y?, image?, imageWidth? }
 * - name: signer's printed name (required).
 * - date: "YYYY-MM-DD" (defaults to today).
 * - page: 1-based (defaults to the LAST page).
 * - x/y: bottom-left corner of the signature block (defaults to bottom-right area).
 * - image: PNG bytes of a handwritten signature (optional; drawn above the line).
 * Returns { bytes, page, x, y, width, height }.
 */
export async function signPdf(bytes, options) {
  const signer = options && typeof options.name === "string" ? options.name.trim() : "";
  if (!signer) fail('a signer name is required (--name "Full Name")');
  const date = options.date === undefined ? new Date().toISOString().slice(0, 10) : String(options.date);
  const doc = await loadPdf(bytes);
  const pageNumber = options.page ?? doc.getPageCount();
  const page = getPage(doc, pageNumber, "sign");

  const nameFont = await doc.embedFont(StandardFonts.HelveticaOblique);
  const labelFont = await doc.embedFont(StandardFonts.Helvetica);
  const nameSize = 18;
  const labelSize = 9;
  const label = encodable(labelFont, `Signed by ${signer} on ${date}`);
  const scriptName = encodable(nameFont, signer);

  let image = null;
  if (options.image) {
    try {
      image = await doc.embedPng(options.image);
    } catch {
      fail("the signature image could not be embedded — it must be a valid PNG file");
    }
    const targetWidth = typeof options.imageWidth === "number" && Number.isFinite(options.imageWidth) ? options.imageWidth : 140;
    image = { png: image, ...image.scale(targetWidth / image.width) };
  }

  const visualWidth = image ? image.width : nameFont.widthOfTextAtSize(scriptName, nameSize);
  const visualHeight = image ? image.height : nameSize;
  const blockWidth = Math.max(visualWidth, labelFont.widthOfTextAtSize(label, labelSize), 140);
  const blockHeight = labelSize + 8 + visualHeight;

  const { width: pageWidth } = page.getSize();
  const x = options.x === undefined ? Math.max(36, pageWidth - blockWidth - 54) : requireNumber(options.x, 'sign: "x"');
  const y = options.y === undefined ? 54 : requireNumber(options.y, 'sign: "y"');

  const ruleY = y + labelSize + 6;
  if (image) {
    page.drawImage(image.png, { x, y: ruleY + 2, width: image.width, height: image.height });
  } else {
    page.drawText(scriptName, { x, y: ruleY + 3, size: nameSize, font: nameFont, color: rgb(0.05, 0.15, 0.4) });
  }
  page.drawLine({ start: { x, y: ruleY }, end: { x: x + blockWidth, y: ruleY }, thickness: 0.9, color: rgb(0.25, 0.25, 0.25) });
  page.drawText(label, { x, y, size: labelSize, font: labelFont, color: rgb(0.3, 0.3, 0.3) });

  return { bytes: await doc.save(), page: pageNumber, x, y, width: blockWidth, height: blockHeight };
}
