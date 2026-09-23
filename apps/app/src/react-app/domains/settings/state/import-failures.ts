export type ImportFailure = { name: string; reason: string };

// Long reasons (e.g. a raw GitHub API response) are cut so the status stays short.
const MAX_REASON_LENGTH = 160;

/**
 * One readable line for the import dialog: the first failure's folder name and
 * reason, plus how many others failed, e.g.
 * "2 failed: nda-review – No SKILL.md in that folder, and 1 more".
 */
export function describeImportFailures(failures: ImportFailure[]): string | null {
  const first = failures[0];
  if (!first) return null;
  const name = first.name.split("/").filter(Boolean).pop() ?? first.name;
  const reason = first.reason.trim().replace(/\.+$/, "");
  const shortReason = reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
  const more = failures.length - 1;
  return `${failures.length} failed: ${name} – ${shortReason}${more ? `, and ${more} more` : ""}`;
}
