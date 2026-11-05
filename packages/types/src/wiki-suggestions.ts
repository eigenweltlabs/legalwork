import { z } from "zod";

export const WikiSuggestionAttachmentInputSchema = z.object({
  sourcePath: z.string().min(1).max(4096).describe("Project-relative path to an already downloaded source file. Existing attachments retain their staged copies when this path and name are unchanged."),
  name: z.string().min(1).max(200).optional().describe("Optional reader-friendly filename, including its original extension."),
});
export const WikiSuggestionAttachmentSchema = WikiSuggestionAttachmentInputSchema.extend({
  name: z.string().min(1).max(200),
  path: z.string(), filePath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export type WikiSuggestionAttachment = z.infer<typeof WikiSuggestionAttachmentSchema>;

export const WikiSuggestionDestinationSchema = z.object({
  wikiId: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  baseRevision: z.string().max(500).nullable(),
  /** Research wiki parents are created when the contribution is published. */
  createFolders: z.boolean().optional(),
});
export const WikiSuggestionInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(2_000_000),
  destination: WikiSuggestionDestinationSchema,
  attachments: z.array(WikiSuggestionAttachmentInputSchema).max(20).optional().describe("Source files to stage with this page, up to 20 files and 100 MB combined. Omit on update to retain attachments; [] removes them. Never write them directly into the wiki."),
});
export const WikiSuggestionSchema = WikiSuggestionInputSchema.extend({
  attachments: z.array(WikiSuggestionAttachmentSchema).max(20).default([]),
  id: z.string().uuid(), workspaceId: z.string(), sessionId: z.string().nullable(),
  status: z.enum(["pending", "saved", "dismissed"]),
  createdAt: z.number(), updatedAt: z.number(),
  revision: z.string(), filePath: z.string(),
});
export type WikiSuggestion = z.infer<typeof WikiSuggestionSchema>;
export type WikiSuggestionInput = z.infer<typeof WikiSuggestionInputSchema>;
export type WikiSuggestionDestination = z.infer<typeof WikiSuggestionDestinationSchema>;
export type WikiContribution = Omit<WikiSuggestion, "content"> & { projectName: string; changes?: import("./line-diff.js").LineChanges | null };

export const WikiSuggestionSourceSchema = z.object({
  workspaceId: z.string().min(1), suggestionId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().min(1),
});
export type WikiSuggestionSource = z.infer<typeof WikiSuggestionSourceSchema>;

export function wikiSuggestionFile(id: string) { return `.legalwork/tmp/wiki-suggestions/${id}/draft.md`; }

/** Old source sections used internal HTML comments that rich editors displayed literally. */
export function withoutWikiSourceMarkers(content: string) {
  return content.replace(/^[ \t]*\\?<!-- \/?legalwork:source-files -->[ \t]*\r?$/gm, "");
}

/** Keep portable source links correct when the user moves a draft or removes a file. */
export function wikiSuggestionContent(content: string, page: string, attachments: Pick<WikiSuggestionAttachment, "name" | "path">[], previous: Pick<WikiSuggestionAttachment, "path">[] = []) {
  let body = withoutWikiSourceMarkers(content);
  if (!attachments.length && !previous.length) return body;
  const managed = new Set([...previous, ...attachments].map(file => file.path));
  const section = /\n+## Source files\n+((?:[-*] \[.*\]\((?:\.\.\/)*Sources\/[^\n]*\)\n?)+)\s*$/.exec(body);
  // Only replace links owned by this draft. Earlier published sources remain
  // part of the page even when the new contribution supplies no attachments.
  const retained = section ? section[1].trimEnd().split("\n").filter(line => {
    const target = /\]\((?:\.\.\/)*(Sources\/.*)\)$/.exec(line)?.[1];
    try { return !target || !managed.has(decodeURIComponent(target)); } catch { return true; }
  }) : [];
  if (section) body = body.slice(0, section.index);
  const folder = page.split("/").slice(0, -1);
  const links = attachments.map(file => {
    const target = file.path.split("/");
    let common = 0;
    while (common < folder.length && folder[common] === target[common]) common++;
    const relative = [...folder.slice(common).map(() => ".."), ...target.slice(common)].map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)).join("/");
    return `- [${file.name.replace(/[\\[\]]/g, "\\$&")}](${relative})`;
  });
  const sources = [...retained, ...links];
  return sources.length ? `${body.trimEnd()}\n\n## Source files\n\n${sources.join("\n")}\n` : body.trimEnd();
}
export function suggestionIdFromFile(path: string) {
  const match = /(?:^|\/)\.legalwork\/tmp\/wiki-suggestions\/([^/]+)\/draft\.md$/.exec(path);
  const id = z.string().uuid().safeParse(match?.[1]);
  return id.success ? id.data : null;
}
