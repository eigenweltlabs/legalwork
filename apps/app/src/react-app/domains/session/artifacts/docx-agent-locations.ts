import type { Node } from "prosemirror-model";
import type { Layout } from "@eigenpal/docx-editor-core/layout-engine";
import { getVanillaNodeText } from "@eigenpal/docx-editor-core/prosemirror/paraText";

export type WordArea = "main" | "table" | "textBox" | "contentControl";
type Container = { kind: Exclude<WordArea, "main">; id: string; row?: number; column?: number; floating?: boolean };
export type WordParagraphLocation = {
  story: string;
  area: WordArea;
  containers: Container[];
  pages: number[];
};
type WritingParagraph = { node: Node; pos: number; paraId: string; index: number; text: string; editable: boolean; location: WordParagraphLocation };
const locationCache = new WeakMap<Node, Map<string, { layout: Layout | null; items: WritingParagraph[] }>>();

/** One live paragraph tree for text, structure, search and write targeting.
 * A paragraph in a floating shape is in document.xml, but is not main text. */
export function wordWritingLocations(doc: Node, layout: Layout | null = null, story = "body") {
  const cached = locationCache.get(doc)?.get(story);
  if (cached?.layout === layout) return cached.items;
  const items: WritingParagraph[] = [];
  const walk = (node: Node, pos: number, containers: Container[]) => {
    if (node.type.name === "paragraph") {
      const paraId = typeof node.attrs.paraId === "string" && node.attrs.paraId ? node.attrs.paraId : `@paragraph:${items.length}`;
      const area = containers.some(container => container.kind === "textBox") ? "textBox"
        : containers.some(container => container.kind === "table") ? "table"
          : containers.length ? "contentControl" : "main";
      items.push({ node, pos, paraId, index: items.length, text: getVanillaNodeText(node), editable: story === "body" && !paraId.startsWith("@paragraph:"), location: { story, area, containers, pages: [] } });
      return;
    }
    node.forEach((child, offset, index) => {
      let next = containers;
      if (child.type.name === "textBox") next = [...containers, { kind: "textBox", id: String(child.attrs.textBoxId ?? `textbox:${pos + 1 + offset}`), floating: child.attrs.displayMode === "float" || child.attrs.wrapType !== "inline" }];
      if (child.type.name === "table") next = [...containers, { kind: "table", id: `table:${pos + 1 + offset}`, floating: Boolean(child.attrs.floating) }];
      if (child.type.name === "blockSdt") next = [...containers, { kind: "contentControl", id: String(child.attrs.id ?? child.attrs.tag ?? `control:${pos + 1 + offset}`) }];
      if (node.type.name === "table" || node.type.name === "tableRow") next = containers.map(container => container === containers.at(-1) && container.kind === "table" ? { ...container, ...(node.type.name === "table" ? { row: index + 1 } : { column: index + 1 }) } : container);
      walk(child, pos + 1 + offset, next);
    });
  };
  walk(doc, -1, []);
  const fragments = (layout?.pages ?? []).flatMap(page => page.fragments.flatMap(fragment => fragment.pmStart !== undefined && fragment.pmEnd !== undefined ? [{ from: fragment.pmStart, to: fragment.pmEnd, page: page.number }] : [])).sort((a, b) => a.from - b.from);
  let next = 0;
  let active: typeof fragments = [];
  for (const item of items) {
    while (next < fragments.length && fragments[next].from < item.pos + item.node.nodeSize) active.push(fragments[next++]);
    active = active.filter(fragment => fragment.to > item.pos);
    item.location.pages = [...new Set(active.map(fragment => fragment.page))];
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.paraId, (counts.get(item.paraId) ?? 0) + 1);
  const result = items.map(item => ({ ...item, editable: item.editable && counts.get(item.paraId) === 1 }));
  const stories = locationCache.get(doc) ?? new Map();
  stories.set(story, { layout, items: result }); locationCache.set(doc, stories);
  return result;
}

export function wordParagraphTarget(doc: Node, paraId: unknown, area: unknown = "main") {
  const matches = wordWritingLocations(doc).filter(item => item.paraId === paraId);
  if (matches.length !== 1 || !matches[0].editable) throw new Error("Paragraph is missing or ambiguous. Read the live document again for a writable paragraph handle.");
  const target = matches[0];
  if (target.location.area !== area) throw new Error(`This paragraph is in ${target.location.area}, not ${String(area)}. Read its location and explicitly supply area=${target.location.area} to edit that container. Use insert_paragraphs with placement=start/end for the main text.`);
  return target;
}

export function wordLocationLabel(location: WordParagraphLocation) {
  const containers = location.containers.map(container => container.kind === "table"
    ? `table ${container.id}, row ${container.row}, col ${container.column}${container.floating ? ", floating" : ""}`
    : `${container.kind} ${container.id}${container.floating ? ", floating" : ""}`);
  return [location.story, location.area, ...containers].join("; ");
}

export function wordParagraphText(items: ReturnType<typeof wordWritingLocations>) {
  return items.map(item => `[${item.paraId}] (${wordLocationLabel(item.location)}) ${item.text}`).join("\n");
}
