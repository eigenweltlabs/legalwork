import JSZip from "jszip";
import * as XLSX from "xlsx";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { BorderStyleTypes, LocaleType, type IWorkbookData, type ICellData, type IStyleData } from "@univerjs/core";

const borderNames: Record<string, BorderStyleTypes> = { thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7, medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12, thick: 13 };
const borderSides: Array<"l" | "r" | "t" | "b"> = ["l", "r", "t", "b"];
const borderTags = { l: "left", r: "right", t: "top", b: "bottom" };
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
type Xml = ReturnType<DOMParser["parseFromString"]>;
type El = NonNullable<Xml["documentElement"]>;
const parse = (source: string) => new DOMParser().parseFromString(source, "application/xml");
const serialize = (doc: Xml) => new XMLSerializer().serializeToString(doc);
const children = (el: El, name: string) => Array.from(el.childNodes).filter((node): node is El => node.nodeType === 1 && node.localName === name);
const first = (el: El, name: string) => children(el, name)[0];
const all = (doc: Xml, name: string) => Array.from(doc.getElementsByTagNameNS(NS, name));
const number = (el: El | undefined, key: string, fallback = 0) => Number(el?.getAttribute(key) ?? fallback);
const rgb = (el: El | undefined) => el?.getAttribute("rgb") ? `#${el.getAttribute("rgb")!.slice(-6)}` : undefined;
const cellKey = (cell: ICellData | undefined) => JSON.stringify([cell?.f || null, cell?.f ? null : cell?.v ?? null, cell?.f ? null : cell?.t ?? null]);
function styleOf(book: IWorkbookData, cell: ICellData | undefined): IStyleData {
  return typeof cell?.s === "string" ? book.styles[cell.s] ?? {} : cell?.s ?? {};
}
function normalizedStyle(style: IStyleData) {
  // This adapter deliberately supports only these cell-format properties.
  return JSON.stringify([style.ff, style.fs, style.bl ?? 0, style.it ?? 0, style.cl?.rgb, style.bg?.rgb, style.ht, style.vt, style.tb, style.n?.pattern, style.ul?.s ?? 0, style.st?.s ?? 0, style.bd]);
}

export async function openWorkbook(buffer: ArrayBuffer, name: string) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`Workbook is missing ${path}.`);
    return parse(await file.async("string"));
  };
  const workbook = await xml("xl/workbook.xml");
  const rels = await xml("xl/_rels/workbook.xml.rels");
  const stylesXml = await xml("xl/styles.xml");
  const xfs = all(stylesXml, "cellXfs")[0];
  const fonts = all(stylesXml, "fonts")[0];
  const fills = all(stylesXml, "fills")[0];
  if (!xfs || !fonts || !fills) throw new Error("This workbook has unsupported styles.");
  const raw = XLSX.read(buffer, { type: "array", cellStyles: true, cellNF: true, cellFormula: true, sheetStubs: true });
  const styles: Record<string, IStyleData> = {};
  const themeFile = zip.file("xl/theme/theme1.xml");
  const themeXml = themeFile ? parse(await themeFile.async("string")) : null;
  const themeKeys = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const color = (element: El | undefined) => {
    const direct = rgb(element);
    if (direct) return direct;
    const key = themeKeys[number(element, "theme", -1)];
    const themeColor = key && themeXml?.getElementsByTagNameNS("*", key)[0]?.firstChild;
    if (!themeColor || themeColor.nodeType !== 1 || !("getAttribute" in themeColor) || typeof themeColor.getAttribute !== "function") return undefined;
    const value = themeColor.getAttribute("val") || themeColor.getAttribute("lastClr");
    if (typeof value !== "string" || !/^[0-9a-f]{6}$/i.test(value)) return undefined;
    const tint = Number(element?.getAttribute("tint") || 0);
    return "#" + [0, 2, 4].map((offset) => { const channel = parseInt(value.slice(offset, offset + 2), 16); return Math.round(tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint).toString(16).padStart(2, "0"); }).join("");
  };
  children(xfs, "xf").forEach((xf, index) => {
    const font = children(fonts, "font")[number(xf, "fontId")];
    const fill = children(fills, "fill")[number(xf, "fillId")];
    const alignment = first(xf, "alignment");
    const border = all(stylesXml, "borders")[0];
    const borderXml = border && children(border, "border")[number(xf, "borderId")];
    const bd: NonNullable<IStyleData["bd"]> = {};
    for (const side of borderSides) { const edge = borderXml && first(borderXml, borderTags[side]); const name = edge?.getAttribute("style"); if (name && borderNames[name]) bd[side] = { s: borderNames[name], cl: { rgb: color(edge && first(edge, "color")) || "#18212f" } }; }
    const formatId = number(xf, "numFmtId");
    const customFormat = all(stylesXml, "numFmt").find((item) => number(item, "numFmtId") === formatId);
    const pattern = customFormat?.getAttribute("formatCode") ?? XLSX.SSF.get_table()[formatId];
    const horizontal = alignment?.getAttribute("horizontal");
    const vertical = alignment?.getAttribute("vertical");
    styles[String(index)] = {
      ff: font && first(font, "name")?.getAttribute("val") || "Calibri",
      fs: font ? number(first(font, "sz"), "val", 11) : 11,
      bl: font && first(font, "b") && first(font, "b")?.getAttribute("val") !== "0" ? 1 : 0,
      it: font && first(font, "i") && first(font, "i")?.getAttribute("val") !== "0" ? 1 : 0,
      cl: { rgb: font && color(first(font, "color")) || "#18212f" },
      bg: { rgb: fill && color(first(first(fill, "patternFill") ?? fill, "fgColor")) || "#ffffff" },
      ul: { s: font && first(font, "u") ? 1 : 0 },
      st: { s: font && first(font, "strike") ? 1 : 0 },
      bd,
      ht: horizontal === "center" ? 2 : horizontal === "right" ? 3 : 1,
      vt: vertical === "top" ? 1 : vertical === "center" ? 2 : 3,
      tb: alignment?.getAttribute("wrapText") === "1" ? 3 : 1,
      ...(pattern ? { n: { pattern } } : {}),
    };
  });
  const book: IWorkbookData = { id: "legalwork-workbook", name, appVersion: "0.25.1", locale: LocaleType.EN_US, styles, sheetOrder: [], sheets: {} };
  const sheets = new Map<string, { path: string; xml: Xml }>();
  let hasAdvancedContent = false;
  for (const [index, sheet] of all(workbook, "sheet").entries()) {
    const id = `sheet-${index}`;
    const sheetName = sheet.getAttribute("name") || `Sheet ${index + 1}`;
    const relId = sheet.getAttribute("r:id");
    const relationship = Array.from(rels.getElementsByTagName("Relationship")).find((item) => item.getAttribute("Id") === relId);
    const target = relationship?.getAttribute("Target");
    if (!target || relationship?.getAttribute("TargetMode") === "External") throw new Error("Unsupported worksheet relationship.");
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const sheetXml = await xml(path);
    if (all(sheetXml, "sheetProtection").length) throw new Error("This workbook contains protected sheets. Open it in Excel to edit it.");
    const source = raw.Sheets[sheetName];
    if (!source) throw new Error(`Cannot read ${sheetName}.`);
    const cellData: NonNullable<IWorkbookData["sheets"][string]["cellData"]> = {};
    for (const el of all(sheetXml, "c")) {
      const address = el.getAttribute("r");
      if (!address) continue;
      const { r, c } = XLSX.utils.decode_cell(address);
      const value: XLSX.CellObject | undefined = source[address];
      if (!cellData[r]) cellData[r] = {};
      cellData[r][c] = { v: value?.v instanceof Date ? value.v.toISOString() : value?.v ?? null, t: value?.t === "n" ? 2 : value?.t === "b" ? 3 : 1, s: el.getAttribute("s") || "0", ...(value?.f ? { f: `=${value.f}` } : {}) };
    }
    const used = XLSX.utils.decode_range(source["!ref"] || "A1");
    if (used.e.r > 99999 || used.e.c > 999) throw new Error("This workbook is too large for the in-app editor. Open it in Excel.");
    const rowData: NonNullable<IWorkbookData["sheets"][string]["rowData"]> = {};
    for (const row of all(sheetXml, "row")) rowData[number(row, "r") - 1] = { ...(row.hasAttribute("ht") ? { h: number(row, "ht") * 4 / 3 } : {}), hd: row.getAttribute("hidden") === "1" ? 1 : 0 };
    const columnData: NonNullable<IWorkbookData["sheets"][string]["columnData"]> = {};
    for (const col of all(sheetXml, "col")) for (let c = number(col, "min") - 1; c < Math.min(number(col, "max"), 1000); c++) columnData[c] = { w: number(col, "width", 12) * 7 + 5, hd: col.getAttribute("hidden") === "1" ? 1 : 0 };
    const pane = all(sheetXml, "pane")[0];
    const frozen = pane?.getAttribute("state")?.startsWith("frozen");
    const x = frozen ? number(pane, "xSplit") : 0;
    const y = frozen ? number(pane, "ySplit") : 0;
    book.sheetOrder.push(id);
    book.sheets[id] = { id, name: sheetName, hidden: sheet.getAttribute("state") === "hidden" || sheet.getAttribute("state") === "veryHidden" ? 1 : 0, rowCount: Math.max(200, used.e.r + 50), columnCount: Math.max(26, used.e.c + 5), cellData, rowData, columnData, mergeData: (source["!merges"] ?? []).map((range) => ({ startRow: range.s.r, endRow: range.e.r, startColumn: range.s.c, endColumn: range.e.c })), freeze: { startRow: y || -1, startColumn: x || -1, xSplit: x, ySplit: y }, defaultColumnWidth: 100, defaultRowHeight: 24 };
    sheets.set(id, { path, xml: sheetXml });
    hasAdvancedContent ||= ["drawing", "legacyDrawing", "dataValidations", "conditionalFormatting", "tableParts"].some((tag) => all(sheetXml, tag).length > 0);
  }
  const baseline = structuredClone(book);
  return { book, hasAdvancedContent, async save(current: IWorkbookData, cacheCalculatedValues = false): Promise<ArrayBuffer> {
    if (JSON.stringify(current.sheetOrder) !== JSON.stringify(baseline.sheetOrder)) throw new Error("Adding, removing, or reordering sheets is not supported yet.");
    // Work from a fresh package on every save. A failed write must not change the baseline.
    const output = await JSZip.loadAsync(buffer);
    let changed = false;
    const outputStyles = parse(serialize(stylesXml));
    const outXfs = all(outputStyles, "cellXfs")[0]!;
    const outFonts = all(outputStyles, "fonts")[0]!;
    const outFills = all(outputStyles, "fills")[0]!;
    const styleCache = new Map<string, number>();
    const make = (doc: Xml, tag: string, attrs: Record<string, string | number> = {}) => {
      const element = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      return element;
    };
    const setStyle = (base: string, style: IStyleData) => {
      const key = base + normalizedStyle(style);
      const cached = styleCache.get(key);
      if (cached !== undefined) return cached;
      const original = children(outXfs, "xf")[Number(base)] ?? children(outXfs, "xf")[0]!;
      const xf = parse(new XMLSerializer().serializeToString(original)).documentElement!;
      const previous = styles[base] ?? {};
      const clone = (element: El) => parse(new XMLSerializer().serializeToString(element)).documentElement!;
      const replace = (parent: El, tag: string, attrs?: Record<string, string | number>) => {
        for (const child of children(parent, tag)) parent.removeChild(child);
        if (attrs) parent.appendChild(make(outputStyles, tag, attrs));
      };
      const fontChanged = JSON.stringify([style.ff, style.fs, style.bl, style.it, style.cl, style.ul?.s, style.st?.s]) !== JSON.stringify([previous.ff, previous.fs, previous.bl, previous.it, previous.cl, previous.ul?.s, previous.st?.s]);
      if (fontChanged) {
        const originalFont = children(outFonts, "font")[number(original, "fontId")] ?? children(outFonts, "font")[0]!;
        const font = clone(originalFont);
        if (style.ff !== previous.ff) { replace(font, "name", { val: style.ff || "Calibri" }); replace(font, "scheme"); }
        if (style.fs !== previous.fs) replace(font, "sz", { val: style.fs || 11 });
        if (style.bl !== previous.bl) replace(font, "b", style.bl ? {} : undefined);
        if (style.it !== previous.it) replace(font, "i", style.it ? {} : undefined);
        if (style.ul?.s !== previous.ul?.s) replace(font, "u", style.ul?.s ? {} : undefined);
        if (style.st?.s !== previous.st?.s) replace(font, "strike", style.st?.s ? {} : undefined);
        if (style.cl?.rgb !== previous.cl?.rgb) replace(font, "color", { rgb: `FF${(style.cl?.rgb || "#18212f").replace("#", "")}` });
        const fontId = children(outFonts, "font").length;
        outFonts.appendChild(outputStyles.importNode(font, true)); outFonts.setAttribute("count", String(fontId + 1));
        xf.setAttribute("fontId", String(fontId)); xf.setAttribute("applyFont", "1");
      }
      if (JSON.stringify(style.bd) !== JSON.stringify(previous.bd)) {
        let borders = all(outputStyles, "borders")[0];
        if (!borders) { borders = make(outputStyles, "borders"); outputStyles.documentElement!.insertBefore(borders, outXfs); }
        const originalBorder = children(borders, "border")[number(original, "borderId")];
        const border = originalBorder ? clone(originalBorder) : make(outputStyles, "border");
        for (const side of borderSides) {
          const edge = style.bd?.[side];
          replace(border, borderTags[side]);
          const element = make(outputStyles, borderTags[side]);
          if (edge?.s) { element.setAttribute("style", Object.keys(borderNames).find((name) => borderNames[name] === edge.s) || "thin"); element.appendChild(make(outputStyles, "color", { rgb: `FF${(edge.cl.rgb || "#18212f").replace("#", "")}` })); }
          border.insertBefore(element, first(border, "diagonal") ?? first(border, "vertical") ?? first(border, "horizontal") ?? null);
        }
        const id = children(borders, "border").length;
        borders.appendChild(outputStyles.importNode(border, true)); borders.setAttribute("count", String(id + 1));
        xf.setAttribute("borderId", String(id)); xf.setAttribute("applyBorder", "1");
      }
      if (style.bg?.rgb !== previous.bg?.rgb) {
        const fill = make(outputStyles, "fill");
        const pattern = make(outputStyles, "patternFill", { patternType: "solid" });
        pattern.appendChild(make(outputStyles, "fgColor", { rgb: `FF${(style.bg?.rgb || "#ffffff").replace("#", "")}` }));
        pattern.appendChild(make(outputStyles, "bgColor", { indexed: 64 })); fill.appendChild(pattern);
        const fillId = children(outFills, "fill").length;
        outFills.appendChild(fill); outFills.setAttribute("count", String(fillId + 1));
        xf.setAttribute("fillId", String(fillId)); xf.setAttribute("applyFill", "1");
      }
      if (style.ht !== previous.ht || style.vt !== previous.vt || style.tb !== previous.tb) {
        let alignment = first(xf, "alignment");
        if (!alignment) { alignment = make(outputStyles, "alignment"); xf.insertBefore(alignment, first(xf, "protection") ?? first(xf, "extLst") ?? null); }
        if (style.ht !== previous.ht) alignment.setAttribute("horizontal", style.ht === 2 ? "center" : style.ht === 3 ? "right" : "left");
        if (style.vt !== previous.vt) alignment.setAttribute("vertical", style.vt === 1 ? "top" : style.vt === 2 ? "center" : "bottom");
        if (style.tb !== previous.tb) alignment.setAttribute("wrapText", style.tb === 3 ? "1" : "0");
        xf.setAttribute("applyAlignment", "1");
      }
      if (style.n?.pattern !== previous.n?.pattern) {
        const pattern = style.n?.pattern;
        let formatId = 0;
        if (pattern && pattern !== "General") {
          let formats = all(outputStyles, "numFmts")[0];
          if (!formats) { formats = make(outputStyles, "numFmts"); outputStyles.documentElement!.insertBefore(formats, outputStyles.documentElement!.firstChild); }
          formatId = Math.max(163, ...children(formats, "numFmt").map((item) => number(item, "numFmtId"))) + 1;
          formats.appendChild(make(outputStyles, "numFmt", { numFmtId: formatId, formatCode: pattern })); formats.setAttribute("count", String(children(formats, "numFmt").length));
        }
        xf.setAttribute("numFmtId", String(formatId)); xf.setAttribute("applyNumberFormat", "1");
      }
      const id = children(outXfs, "xf").length;
      outXfs.appendChild(outputStyles.importNode(xf, true)); outXfs.setAttribute("count", String(id + 1)); styleCache.set(key, id); return id;
    };
    for (const [id, original] of sheets) {
      const sheet = current.sheets[id]; const before = baseline.sheets[id]!;
      if (!sheet || sheet.name !== before.name || sheet.hidden !== before.hidden || JSON.stringify(sheet.mergeData) !== JSON.stringify(before.mergeData)) throw new Error("Sheet structure changes are not supported yet. Reopen the file to discard them.");
      for (const row of new Set([...Object.keys(before.rowData ?? {}), ...Object.keys(sheet.rowData ?? {})])) {
        const a = before.rowData?.[Number(row)]; const b = sheet.rowData?.[Number(row)];
        if (JSON.stringify([a?.h ?? null, a?.hd ?? 0, a?.s ?? null]) !== JSON.stringify([b?.h ?? null, b?.hd ?? 0, b?.s ?? null])) throw new Error("Row layout changes must be made in Excel.");
      }
      for (const col of new Set([...Object.keys(before.columnData ?? {}), ...Object.keys(sheet.columnData ?? {})])) {
        const a = before.columnData?.[Number(col)]; const b = sheet.columnData?.[Number(col)];
        if (JSON.stringify([a?.w ?? null, a?.hd ?? 0, a?.s ?? null]) !== JSON.stringify([b?.w ?? null, b?.hd ?? 0, b?.s ?? null])) throw new Error("Column layout changes must be made in Excel.");
      }
      const doc = parse(serialize(original.xml));
      const sheetData = all(doc, "sheetData")[0];
      if (!sheetData) throw new Error("Missing worksheet data.");
      const cells = new Map(all(doc, "c").map((cell) => [cell.getAttribute("r"), cell]));
      let sheetChanged = false;
      const rows = new Set([...Object.keys(before.cellData ?? {}), ...Object.keys(sheet.cellData ?? {})]);
      for (const rowKey of rows) {
        const r = Number(rowKey);
        const columns = new Set([...Object.keys(before.cellData?.[r] ?? {}), ...Object.keys(sheet.cellData?.[r] ?? {})]);
        for (const colKey of columns) {
          const c = Number(colKey); const old = before.cellData?.[r]?.[c]; const cell = sheet.cellData?.[r]?.[c];
          const valueChanged = cellKey(old) !== cellKey(cell);
          const formatChanged = normalizedStyle(styleOf(baseline, old)) !== normalizedStyle(styleOf(current, cell));
          if (!valueChanged && !formatChanged) continue;
          if (cell?.p) throw new Error("Rich-text cell edits are not supported. Use plain cell text.");
          const address = XLSX.utils.encode_cell({ r, c });
          let el = cells.get(address);
          const arrayFormula = all(original.xml, "f").find((formula) => {
            if (formula.getAttribute("t") !== "array") return false;
            const reference = formula.getAttribute("ref");
            if (!reference) return false;
            const range = XLSX.utils.decode_range(reference);
            return r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c;
          });
          if (valueChanged && arrayFormula) throw new Error(`Array formula range ${arrayFormula.getAttribute("ref")} must be edited in Excel.`);
          if (!el) {
            let row = children(sheetData, "row").find((item) => number(item, "r") === r + 1);
            if (!row) { row = make(doc, "row", { r: r + 1 }); sheetData.insertBefore(row, children(sheetData, "row").find((item) => number(item, "r") > r + 1) ?? null); }
            el = make(doc, "c", { r: address }); row.insertBefore(el, children(row, "c").find((item) => XLSX.utils.decode_cell(item.getAttribute("r") || "A1").c > c) ?? null);
          }
          if (formatChanged) el.setAttribute("s", String(setStyle(typeof old?.s === "string" ? old.s : "0", styleOf(current, cell))));
          if (valueChanged) {
            for (const tag of ["v", "f", "is"]) for (const node of children(el, tag)) el.removeChild(node);
            el.removeAttribute("t");
            if (cell?.f) { const formula = make(doc, "f"); formula.textContent = cell.f.replace(/^=/, ""); el.appendChild(formula); }
            else if (cell?.v !== null && cell?.v !== undefined) {
              if (typeof cell.v === "number" || typeof cell.v === "boolean" || cell.t === 3) { if (typeof cell.v === "boolean" || cell.t === 3) el.setAttribute("t", "b"); const value = make(doc, "v"); value.textContent = typeof cell.v === "boolean" ? (cell.v ? "1" : "0") : String(cell.v); el.appendChild(value); }
              else { el.setAttribute("t", "inlineStr"); const inline = make(doc, "is"); const text = make(doc, "t", { "xml:space": "preserve" }); text.textContent = String(cell.v); inline.appendChild(text); el.appendChild(inline); }
            }
          }
          sheetChanged = true;
        }
      }
      if (sheetChanged) {
        // Materialize shared formulas, whose anchors may have been edited, and
        // discard formula caches so Excel recalculates instead of displaying stale values.
        for (const cell of all(doc, "c")) {
          const address = cell.getAttribute("r") || "A1";
          const { r, c } = XLSX.utils.decode_cell(address);
          const formula = first(cell, "f");
          if (formula?.getAttribute("t") === "shared") { formula.removeAttribute("t"); formula.removeAttribute("si"); formula.removeAttribute("ref"); formula.textContent = sheet.cellData?.[r]?.[c]?.f?.replace(/^=/, "") || formula.textContent; }
          if (formula) for (const value of children(cell, "v")) cell.removeChild(value);
        }
        const dimension = all(doc, "dimension")[0];
        if (dimension) { const addresses = all(doc, "c").map((cell) => XLSX.utils.decode_cell(cell.getAttribute("r") || "A1")); dimension.setAttribute("ref", XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, ...addresses.map((cell) => cell.r)), c: Math.max(0, ...addresses.map((cell) => cell.c)) } })); }
        output.file(original.path, serialize(doc)); changed = true;
      }
    }
    if (!changed) return buffer.slice(0);
    output.file("xl/styles.xml", serialize(outputStyles));
    const wb = parse(serialize(workbook));
    let calc = all(wb, "calcPr")[0]; if (!calc) { calc = make(wb, "calcPr"); wb.documentElement!.appendChild(calc); }
    calc.setAttribute("calcMode", "auto"); calc.setAttribute("fullCalcOnLoad", "1"); calc.setAttribute("forceFullCalc", "1"); output.file("xl/workbook.xml", serialize(wb));
    // Recalculation must also invalidate caches on other sheets.
    for (const [id, { path }] of sheets) {
      const doc = parse(await output.file(path)!.async("string")); let touched = false;
      for (const cell of all(doc, "c")) if (first(cell, "f")) {
        for (const value of children(cell, "v")) { cell.removeChild(value); touched = true; }
        const address = XLSX.utils.decode_cell(cell.getAttribute("r") || "A1");
        const value = current.sheets[id]?.cellData?.[address.r]?.[address.c]?.v;
        if (cacheCalculatedValues && typeof value === "number" && Number.isFinite(value)) {
          const cached = make(doc, "v"); cached.textContent = String(value); cell.appendChild(cached); cell.removeAttribute("t"); touched = true;
        }
      }
      if (touched) output.file(path, serialize(doc));
    }
    if (cacheCalculatedValues) {
      const chartNs = "http://schemas.openxmlformats.org/drawingml/2006/chart";
      for (const path of Object.keys(output.files).filter((path) => /^xl\/charts\/chart[^/]*\.xml$/.test(path))) {
        const doc = parse(await output.file(path)!.async("string")); let touched = false;
        for (const reference of Array.from(doc.getElementsByTagNameNS(chartNs, "numRef"))) {
          const formula = first(reference, "f")?.textContent;
          const cache = first(reference, "numCache");
          const match = formula?.match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z$]+[0-9]+):([A-Z$]+[0-9]+)$/i);
          if (!match || !cache) continue;
          const name = (match[1] || match[2])!.replace(/''/g, "'");
          const sheet = Object.values(current.sheets).find((sheet) => sheet.name === name);
          if (!sheet) continue;
          const range = XLSX.utils.decode_range(`${match[3]}:${match[4]}`);
          if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 100000) continue;
          const values: number[] = [];
          for (let row = range.s.r; row <= range.e.r; row++) for (let col = range.s.c; col <= range.e.c; col++) {
            const value = sheet.cellData?.[row]?.[col]?.v;
            values.push(typeof value === "number" ? value : NaN);
          }
          if (!values.every(Number.isFinite)) continue;
          const count = first(cache, "ptCount"); if (count) count.setAttribute("val", String(values.length));
          for (const point of children(cache, "pt")) cache.removeChild(point);
          values.forEach((value, index) => { const point = doc.createElementNS(chartNs, "c:pt"); point.setAttribute("idx", String(index)); const node = doc.createElementNS(chartNs, "c:v"); node.textContent = String(value); point.appendChild(node); cache.appendChild(point); });
          touched = true;
        }
        if (touched) output.file(path, serialize(doc));
      }
    }
    output.remove("xl/calcChain.xml");
    for (const path of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) { const doc = await xml(path); for (const node of Array.from(doc.documentElement!.childNodes)) if (node.nodeType === 1 && new XMLSerializer().serializeToString(node).includes("calcChain")) doc.documentElement!.removeChild(node); output.file(path, serialize(doc)); }
    return output.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  } };
}
