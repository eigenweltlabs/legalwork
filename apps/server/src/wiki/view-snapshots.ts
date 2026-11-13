import type { ViewRecord, WikiViewSnapshots, ViewOwner } from "@legalwork/types/views";
import type { WikiPage } from "@legalwork/types/wiki";
import { isBackOfficeQuery, ViewInputSchema, parseViewReference, viewReferenceKey } from "../views/schema.js";
import { ViewRepository, type ViewFiles } from "../views/repository.js";
import { queryWikiPages } from "./data-query.js";

/** Capture embedded programs and resolved query rows together, never fetch them on historical reads. */
export async function captureWikiViews(content: string, owner: ViewOwner, files: ViewFiles, pages: () => Promise<WikiPage[]>): Promise<WikiViewSnapshots> {
  const sources = [...content.matchAll(/(?:`{3,}|~{3,})legalwork-view\s*\r?\n([\s\S]*?)\r?\n(?:`{3,}|~{3,})/g)].map(match => match[1].trim());
  sources.push(...[...content.matchAll(/legalwork-view:\/\/[^\s)<>"']+/g)].map(match => match[0]));
  const references = new Map(sources.map(source => { const reference = parseViewReference(source, owner); return [reference ? viewReferenceKey(reference) : "", reference]; }));
  const result: WikiViewSnapshots = {};
  const repository = new ViewRepository(owner, files);
  let indexed: WikiPage[] | undefined, records: ViewRecord[] | undefined, bytes = 0;
  const localReferences = [...references].filter(([, reference]) => reference?.owner.kind === owner.kind && reference.owner.id === owner.id);
  for (const [key, reference] of localReferences.slice(0, 20)) {
    // Cross-owner embeds must not copy another project's private data into wiki history.
    if (!reference || reference.owner.kind !== owner.kind || reference.owner.id !== owner.id) continue;
    try {
      records ??= await repository.readAll();
      const view = records.find(record => record.id === reference.viewId);
      if (!view) continue;
      const input = ViewInputSchema.strip().parse(view);
      // Wiki history is shared. A live firm directory is resolved per viewer.
      if (view.mode === "dashboard" && Object.values(view.queries).some(isBackOfficeQuery)) continue;
      if (view.mode === "dashboard" && Object.keys(view.queries).length) {
        indexed ??= await pages();
        input.datasets = { ...input.datasets };
        for (const [name, query] of Object.entries(view.queries)) input.datasets[name] = { ...queryWikiPages(indexed, query), sourceOwner: owner };
      }
      if (Object.keys(input.queries).some(name => !input.datasets?.[name])) continue;
      input.queries = {};
      const size = Buffer.byteLength(JSON.stringify(input));
      if (bytes + size > 8 * 1024 * 1024) continue;
      bytes += size;
      result[key] = input;
    } catch { /* Missing/corrupt embeds remain explicitly unavailable in the historical renderer. */ }
  }
  return result;
}
