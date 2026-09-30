import type { DocumentRegion, DocumentRelation, PageStructure } from "@legalwork/types/document-structure";

type StructuredPage = { page: number; structure?: PageStructure | null };
type LocatedRegion = { page: number; region: DocumentRegion };

const bodyKinds = new Set<DocumentRegion["kind"]>(["text", "list"]);
const referenceSources = new Set<DocumentRegion["kind"]>(["note", "text", "list", "footnote"]);
const referencePattern = /\b(?:section|clause|article|paragraph|sec\.?|art\.?|ziffer|abschnitt|artikel|klausel|nummer|nr\.?)\s+(\d+(?:\.\d+){0,5}[a-z]?)\b|§\s*(\d+(?:\.\d+){0,5}[a-z]?)\b/giu;
const namedHeadingPattern = /^\s*(?:§\s*|(?:section|clause|article|paragraph|sec\.?|art\.?|ziffer|abschnitt|artikel|klausel)\s+)(\d+(?:\.\d+){0,5}[a-z]?)\b/iu;
const bareHeadingPattern = /^\s*(\d+(?:\.\d+){0,5}[a-z]?)[.)]?\s+\S/iu;

function numberId(value: string): string { return value.toLowerCase().replace(/\.$/, ""); }
function headingId(region: DocumentRegion): string | undefined {
  if (region.kind !== "heading" && region.kind !== "list" && region.kind !== "text") return;
  const line = region.text.split(/\r?\n/, 1)[0] ?? "";
  const named = namedHeadingPattern.exec(line);
  if (named) return numberId(named[1]);
  const bare = bareHeadingPattern.exec(line);
  return bare ? numberId(bare[1]) : undefined;
}

function relation(kind: DocumentRelation["kind"], source: LocatedRegion, target: LocatedRegion,
  status: DocumentRelation["status"], basis: DocumentRelation["basis"], explanation: string): DocumentRelation {
  return { id: `${kind}:${source.page}:${source.region.id}:${target.page}:${target.region.id}:${basis}`,
    kind, source: { page: source.page, regionId: source.region.id },
    target: { page: target.page, regionId: target.region.id }, status, basis, explanation };
}
function orderedBody(page: StructuredPage): DocumentRegion[] {
  const structure = page.structure;
  if (!structure) return [];
  const ids = new Map(structure.regions.map(region => [region.id, region]));
  return structure.readingOrder.map(id => ids.get(id)).filter((region): region is DocumentRegion => Boolean(region))
    .filter(region => bodyKinds.has(region.kind));
}
function amendmentKind(text: string, matchStart: number): DocumentRelation["kind"] {
  const before = text.slice(Math.max(0, matchStart - 70), matchStart).split(/[.;\n]/).at(-1) ?? "";
  const after = text.slice(matchStart, matchStart + 70).split(/[.;\n]/, 1)[0] ?? "";
  if (/\b(?:replac(?:e|es|ed|ing)|substitut(?:e|es|ed)|ersetz\w*)\b/iu.test(before)) return "replaces";
  if (/\b(?:wird|shall be|is to be)\s+(?:vollst\u00e4ndig\s+)?(?:ersetz\w*|replac\w*)\b/iu.test(after)) return "replaces";
  if (/\b(?:delet(?:e|es|ed|ing)|strik(?:e|es|ing)|streich\w*|entf\w*)\b/iu.test(before)) return "deletes";
  if (/\b(?:amend\w*|modif\w*|insert\w*|einf(?:\u00fc|ue)g\w*)\b|(?:^|\s)(?:\u00e4nder\w*|erg\u00e4nz\w*)(?=\s|$)/iu.test(before)) return "amends";
  return "references";
}
function explicitReference(text: string, matchStart: number, kind: DocumentRelation["kind"]): boolean {
  if (kind !== "references") return true;
  const before = text.slice(Math.max(0, matchStart - 45), matchStart).split(/[.;\n]/).at(-1) ?? "";
  return /\b(?:see|refer(?:s|red)?\s+to|pursuant\s+to|according\s+to|under|in|siehe|gem\u00e4\u00df|nach|zu|vgl\.?)\s*$/iu.test(before);
}
function firstHeader(table: PageStructure["tables"][number]): string {
  return table.cells.filter(cell => cell.row === 0).sort((a, b) => a.column - b.column)
    .map(cell => cell.text.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
}
function alignedColumns(a: PageStructure["tables"][number], b: PageStructure["tables"][number]): boolean {
  for (let column = 0; column < a.columns; column++) {
    const left = a.cells.find(cell => cell.row === 0 && cell.column === column && cell.columnSpan === 1);
    const right = b.cells.find(cell => cell.row === 0 && cell.column === column && cell.columnSpan === 1);
    if (!left || !right || Math.abs(left.box.x - right.box.x) > .04
      || Math.abs(left.box.width - right.box.width) > .06) return false;
  }
  return true;
}

/** Links only observed page regions; a missing page or unresolved reference never creates a synthetic endpoint. */
export function linkDocumentStructure(pages: StructuredPage[]): DocumentRelation[] {
  const usable = pages.filter(page => Number.isSafeInteger(page.page) && page.page > 0 && page.structure?.status !== "unavailable");
  const counts = new Map<number, number>();
  for (const page of usable) counts.set(page.page, (counts.get(page.page) ?? 0) + 1);
  const unique = usable.filter(page => counts.get(page.page) === 1 && page.structure
    && new Set(page.structure.regions.map(region => region.id)).size === page.structure.regions.length);
  unique.sort((a, b) => a.page - b.page);
  const pageByNumber = new Map(unique.map(page => [page.page, page]));
  const regions = unique.flatMap(page => page.structure?.regions.map(region => ({ page: page.page, region })) ?? []);
  const ids = new Map<string, LocatedRegion[]>();
  for (const item of regions) {
    const id = headingId(item.region);
    if (id) ids.set(id, [...ids.get(id) ?? [], item]);
  }
  const output = new Map<string, DocumentRelation>();
  const add = (value: DocumentRelation): void => { if (output.size < 2000 && !output.has(value.id)) output.set(value.id, value); };
  const contiguous = (a: number, b: number): boolean => {
    for (let page = Math.min(a, b); page <= Math.max(a, b); page++) if (!pageByNumber.has(page)) return false;
    return true;
  };

  for (const source of regions) {
    if (!referenceSources.has(source.region.kind)) continue;
    for (const match of source.region.text.matchAll(referencePattern)) {
      const number = numberId(match[1] ?? match[2]);
      const candidates = (ids.get(number) ?? []).filter(target =>
        (target.page !== source.page || target.region.id !== source.region.id) && contiguous(source.page, target.page));
      if (!candidates.length || candidates.length > 3) continue;
      const kind = amendmentKind(source.region.text, match.index);
      if (!explicitReference(source.region.text, match.index, kind)) continue;
      for (const target of candidates) add(relation(kind, source, target,
        candidates.length === 1 && kind === "references" && target.region.kind === "heading" ? "supported" : "candidate", "text-reference",
        candidates.length === 1 ? `Text explicitly names ${match[0]}.` : `Text names ${match[0]}, which has multiple possible targets.`));
    }
  }

  for (const left of unique) {
    const right = pageByNumber.get(left.page + 1);
    if (!right || !left.structure || !right.structure) continue;
    const last = orderedBody(left).at(-1);
    const first = orderedBody(right)[0];
    if (left.structure.status === "complete" && right.structure.status === "complete"
      && last && first && last.box.y + last.box.height >= .78 && first.box.y <= .22
      && Math.abs(last.box.x - first.box.x) <= .08 && Math.abs(last.box.width - first.box.width) <= .12
      && /[\p{L}\p{N},;–—-]$/u.test(last.text.trim()) && /^\p{Ll}/u.test(first.text.trim())) {
      add(relation("continues", { page: left.page, region: last }, { page: right.page, region: first },
        "candidate", "page-boundary", "Text reaches the lower page edge and resumes with a lowercase start on the next page."));
    }
    const leftTable = left.structure.regions.filter(region => region.kind === "table" && region.box.y + region.box.height >= .78).at(-1);
    const rightTable = right.structure.regions.find(region => region.kind === "table" && region.box.y <= .22);
    if (!leftTable || !rightTable || Math.abs(leftTable.box.x - rightTable.box.x) > .04
      || Math.abs(leftTable.box.width - rightTable.box.width) > .08) continue;
    const a = left.structure.tables.find(table => table.regionId === leftTable.id);
    const b = right.structure.tables.find(table => table.regionId === rightTable.id);
    if (!a || !b || a.columns < 2 || a.columns !== b.columns || !alignedColumns(a, b)) continue;
    const headerA = firstHeader(a);
    const headerB = firstHeader(b);
    if (!headerA || !headerB || headerA !== headerB) continue;
    add(relation("table-continues", { page: left.page, region: leftTable }, { page: right.page, region: rightTable },
      "candidate", "table-columns", "Adjacent boundary tables have aligned boxes, the same column count, and a repeated first row."));
  }
  return [...output.values()];
}
