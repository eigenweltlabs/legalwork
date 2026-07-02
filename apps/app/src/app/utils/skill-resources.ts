// The server keeps a delimited "Attached resources" block in a SKILL.md body
// in sync with the skill's resources/ folder (regenerated whenever a file is
// attached or removed — see apps/server/src/skill-resources.ts). This helper
// carries the server-rendered block into editor content that may hold unsaved
// edits, so saving the editor never writes a stale block back to disk.

const SECTION_BLOCK_REGEX = /<!-- legalwork:resources:start -->[\s\S]*?<!-- legalwork:resources:end -->/;
const SECTION_STRIP_REGEX =
  /(?:\r?\n)*<!-- legalwork:resources:start -->[\s\S]*?<!-- legalwork:resources:end -->(?:\r?\n)*/g;

/**
 * Return `currentContent` with its attached-resources block replaced by the one
 * in `serverContent` (or removed when the server content has none). Everything
 * outside the delimited block — user edits included — is left untouched.
 */
export function syncAttachedFilesSection(currentContent: string, serverContent: string): string {
  const block = serverContent.match(SECTION_BLOCK_REGEX)?.[0];
  const stripped = currentContent.replace(SECTION_STRIP_REGEX, "\n").replace(/\s+$/, "");
  if (!block) return stripped ? `${stripped}\n` : "";
  return stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
}
