import { randomUUID } from "node:crypto";
import { savedWorkdayInstructionSchema } from "../back-office/timesheet-schema.js";
import { z } from "zod";

const term = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}-]{0,119}$/u);
const documentTermSchema = z.object({ from: term, to: term });
export const privateInstructionSchema = savedWorkdayInstructionSchema.extend({
  entryKey: z.string().optional(),
  entryRevision: z.number().int().positive().optional(),
  replacement: documentTermSchema.optional(),
});
export type PrivateInstruction = z.infer<typeof privateInstructionSchema>;

export function correctedDocumentTerm(before: string, after: string) {
  const pieces = (value: string) => value.trim().replace(/\s+/gu, " ")
    .split(/([\p{L}\p{N}][\p{L}\p{N}-]*)/u);
  const original = pieces(before), edited = pieces(after);
  if (original.length !== edited.length) return;
  const changes = original.flatMap((from, index) => {
    const to = edited[index];
    if (from.toLowerCase() === to.toLowerCase()) return [];
    return [{ from, to }];
  });
  const first = changes[0];
  if (!first || changes.some(change => change.from !== first.from || change.to !== first.to)) return;
  const parsed = documentTermSchema.safeParse(first);
  if (parsed.success) return parsed.data;
}

export function replaceDocumentTerm(text: string, from: string, to: string) {
  const literal = from.replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp("(?<![\\p{L}\\p{N}])" + literal + "(?![\\p{L}\\p{N}])", "giu"), () => to);
}

export function rememberDocumentWording(instructions: Record<string, PrivateInstruction>, entryKey: string,
  documentId: string, matterId: string, before: string, after: string, sourceTitle?: string, entryRevision?: number) {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
  if (!after.trim() || normalize(before) === normalize(after)) return false;
  const examples = Object.values(instructions).filter(rule => rule.kind === "wording-example" &&
    rule.documentId === documentId && rule.matterId === matterId);
  const change = correctedDocumentTerm(before, after);
  const prior = change && examples.filter(rule => rule.replacement?.to.toLowerCase() === change.from.toLowerCase()).at(-1)?.replacement;
  const sameEntry = examples.find(rule => rule.entryKey === entryKey);
  const old = sameEntry?.replacement;
  const replacement = change && (prior || (sourceTitle && replaceDocumentTerm(sourceTitle, change.from, "") !== sourceTitle))
    ? { from: prior?.from ?? change.from, to: change.to }
    : old && replaceDocumentTerm(after, old.to, "") !== after ? old : undefined;
  if (entryRevision === undefined ? sameEntry?.text === after
    : sameEntry?.entryRevision !== undefined && entryRevision <= sameEntry.entryRevision) return false;
  if (sameEntry) delete instructions[sameEntry.id];
  for (const old of examples.filter(rule => rule !== sameEntry).slice(0, -3)) delete instructions[old.id];
  const id = sameEntry?.id ?? randomUUID();
  instructions[id] = { id, scope: "document", documentId, matterId, entryKey, entryRevision, kind: "wording-example",
    text: after.trim().slice(0, 2000), replacement };
  return true;
}
