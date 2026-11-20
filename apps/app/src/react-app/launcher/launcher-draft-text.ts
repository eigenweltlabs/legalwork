import type { LauncherDraft } from "@legalwork/types/launcher";
import { projectFilePath } from "@legalwork/types/project-files";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "@/react-app/domains/session/surface/composer/mention-encoding";
import { taskReference } from "@/react-app/domains/tasks/task-reference";
import { createProjectAttachmentMention, createWorkspaceAttachmentMention, parseWorkspaceAttachmentMention } from "@/react-app/domains/session/surface/composer/workspace-attachment";

/** The panel's complete draft as Home composer text: file references become attachment mentions, captured text is quoted. */
export function launcherDraftToComposerText(draft: Pick<LauncherDraft, "text" | "context">, assistantWorkspaceId: string, projectNames: Map<string, string>, mentions: Record<string, ComposerMentionKind> = {}) {
  const parts = [draft.text.trim()];
  for (const item of draft.context) {
    if (item.type === "task") parts.push(taskReference(item.taskId));
    else if ((item.type === "file" || item.type === "image") && item.path) {
      const value = item.workspaceId && item.workspaceId !== assistantWorkspaceId
        ? createProjectAttachmentMention({ projectId: item.workspaceId, workspaceId: item.workspaceId, path: item.path, name: item.name }, projectNames.get(item.workspaceId) ?? (item.type === "file" ? item.sourceLabel : null) ?? item.workspaceId, item.id)
        : createWorkspaceAttachmentMention(item.name, item.path);
      mentions[value] = "upload";
      parts.push("@" + encodeComposerMentionValue(value));
    }
    else if (item.type === "selection") parts.push(`${item.sourceApp ? `${item.sourceApp}${item.sourceWindow ? ` (${item.sourceWindow})` : ""}:\n` : ""}"""\n${item.text}\n"""`);
    else if (item.type === "clipboard") parts.push(`"""\n${item.text}\n"""`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Restore file chips from a Home draft, including drafts saved before the handoff understood upload mentions. */
export function splitLauncherAttachments(text: string, workspaceId: string, existing: LauncherDraft["context"], mentions: Record<string, ComposerMentionKind> = {}) {
  const context = [...existing];
  const cleaned = text.replace(/(^|\s)@?(attachment:\/\/workspace\?[^\s@]+)/g, (token: string, lead: string, value: string, offset: number) => {
    const raw = token.trimStart().startsWith("@") ? decodeComposerMentionValue(value) : value;
    // Legacy generated references occupied a line of their own. Within prose,
    // only interpret an actual composer chip.
    if (mentions[raw] !== "upload") {
      const start = offset + lead.length;
      const end = offset + token.length;
      const nextLine = text.indexOf("\n", end);
      if (text.slice(text.lastIndexOf("\n", start - 1) + 1, start).trim() ||
          text.slice(end, nextLine < 0 ? text.length : nextLine).trim()) return token;
    }
    const file = parseWorkspaceAttachmentMention(raw);
    if (!file || !projectFilePath.safeParse(file.path).success) return token;
    // A connected project or versioned snapshot needs its full composer metadata
    // to resolve on send. Only convert references a launcher file can represent.
    if (file.version || file.source?.connectionId || file.source && file.source.projectId !== file.source.workspaceId) return token;
    const sourceId = file.source?.workspaceId ?? workspaceId;
    const path = file.source?.path ?? file.path;
    if (!context.some(item => (item.type === "file" || item.type === "image") && item.workspaceId === sourceId && item.path === path)) {
      context.push({ type: "file", id: crypto.randomUUID(), workspaceId: sourceId, name: file.source?.name ?? file.name, path, revision: file.version ?? null, sourceLabel: null });
    }
    return lead;
  });
  return { text: cleaned === text ? text : cleaned.trim(), context };
}
