import type { TimeDraft, resolveTimePolicy } from "@legalwork/types/timesheet-core";

const englishAction: Record<string, string> = {
  amended: "Amending",
  drafted: "Drafting",
  reviewed: "Reviewing",
  researched: "Researching",
  revised: "Revising",
};
const escape = (literal: string) =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, (character) => "\\" + character);

/** Apply vocabulary that the firm approved. Do not infer a different service from the text. */
export function checkBillingNarrative(
  entry: Pick<TimeDraft, "narrative" | "activity">,
  policy: ReturnType<typeof resolveTimePolicy>,
) {
  const original = entry.narrative.trim();
  let next = original;
  const replacements = new Map<string, string>();
  let actionFirst = false;
  const vocabulary = {
    ammending: "Amending",
    Liefervertäge: "Lieferverträge",
    ...policy.narrativeCorrections,
  };
  const corrections = new Map(Object.entries(vocabulary).map(([from, to]) => [from.toLowerCase(), to]));
  const words = [...corrections.keys()].sort((a, b) => b.length - a.length);
  if (words.length) {
    const pattern = new RegExp(
      "(^|[^\\p{L}\\p{N}_])(" + words.map(escape).join("|") + ")(?![\\p{L}\\p{N}_])",
      "giu",
    );
    next = next.replace(
      pattern,
      (_match, prefix: string, from: string) => {
        const to = corrections.get(from.toLowerCase()) ?? from;
        if (from !== to) replacements.set(from, to);
        return prefix + to;
      },
    );
  }
  if (policy.actionFirst && /^(en(?:g(?:lish|lisch)?)?($|-))/i.test(policy.language)) {
    const match = /^(.+?)\s+(amended|drafted|reviewed|researched|revised)([.!]?)$/i.exec(next);
    if (match) {
      actionFirst = true;
      next =
        (policy.actionWords[entry.activity] || englishAction[match[2].toLowerCase()]) +
        " " +
        match[1] +
        match[3];
    }
  }
  return next !== original ? { narrative: next, actionFirst, replacements } : undefined;
}

export function suggestBillingNarrative(
  entry: Pick<TimeDraft, "narrative" | "activity">,
  policy: ReturnType<typeof resolveTimePolicy>,
) {
  return checkBillingNarrative(entry, policy)?.narrative;
}
