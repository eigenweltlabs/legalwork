import { z } from "zod";

export const browserConnectionOutput = z.object({
  tabID: z.string(),
  browser_url: z.string(),
  url: z.string(),
  snapshot: z.object({
    content: z.string(), truncated: z.boolean(),
    tab: z.object({ id: z.string(), url: z.string(), generation: z.number() }).passthrough(),
  }).passthrough(),
}).passthrough();

/** The UI bridge envelope is transport detail, not the browser tool contract. */
export function browserConnectionResult(value: unknown) {
  const envelope = z.object({ ok: z.literal(true), result: z.object({ tab_id: z.string() }).passthrough() }).parse(value);
  const { tab_id, ...result } = envelope.result;
  return browserConnectionOutput.parse({ ...result, tabID: tab_id });
}

/** Keep tool results valid JSON and below the engine's generic truncation limit.
 * Detail remains available through the next snapshotOffset/controlsOffset. */
function splitNames(items: unknown[]) {
  return items.flatMap(item => {
    if (!item || typeof item !== "object") return [item];
    const name: unknown = Reflect.get(item, "name");
    if (typeof name !== "string" || name.length <= 1_000) return [item];
    const chunks: unknown[] = [];
    for (let start = 0; start < name.length; start += 1_000) chunks.push({ ...item, name: name.slice(start, start + 1_000), textOffset: start, textLength: name.length });
    return chunks;
  });
}

function page(items: unknown[], offset: number, budget: number) {
  const output: unknown[] = [];
  let size = 0;
  for (const item of items.slice(offset)) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (output.length && size + bytes > budget) break;
    output.push(item);
    size += bytes;
  }
  const next = offset + output.length;
  return { items: output, total: items.length, ...(next < items.length ? { nextOffset: next } : {}) };
}

export function compactBrowserResult(value: unknown, snapshotOffset = 0, controlsOffset = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result: unknown = Reflect.get(value, "result");
  if (result) return { ...value, result: compactBrowserResult(result, snapshotOffset, controlsOffset) };
  const snapshot: unknown = Reflect.get(value, "snapshot");
  if (!snapshot || typeof snapshot !== "object") return value;
  const elements: unknown = Reflect.get(snapshot, "elements"), controls: unknown = Reflect.get(snapshot, "controls");
  if (!Array.isArray(elements) || !Array.isArray(controls)) return value;
  const seen = new Set<string>();
  const content = elements.filter(element => {
    if (!element || typeof element !== "object") return false;
    const role: unknown = Reflect.get(element, "role"), name: unknown = Reflect.get(element, "name");
    if (typeof name !== "string" || !name.trim() || role === "InlineTextBox" || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const text = page(splitNames(content), snapshotOffset, 16_000), actions = page(splitNames(controls), controlsOffset, 8_000);
  return { ...value, snapshot: { ...snapshot, elements: text.items, controls: actions.items,
    pagination: { totalElements: text.total, totalControls: actions.total,
      ...(text.nextOffset !== undefined ? { snapshotOffset: text.nextOffset } : {}),
      ...(actions.nextOffset !== undefined ? { controlsOffset: actions.nextOffset } : {}),
      instruction: "For more detail call legalwork_browser_batch with steps:[] and the returned offsets. Offsets refer to the current page." } } };
}
