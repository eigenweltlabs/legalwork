import { parseIntegrationMention, integrationDisplayText, integrationInstruction } from "./integration-mention";
import type { ComposerAttachment, ComposerDraft, ComposerPart } from "@/app/types";
import type { ComposerPastePart } from "../composer-state-store";
import {
  decodeComposerMentionValue, encodeComposerMentionValue, legalMemoryComposerInstruction, legalMemoryComposerDisplayText,
  storageComposerInstruction, storageComposerDisplayText, reviewComposerInstruction, reviewComposerDisplayText,
  calendarComposerInstruction, calendarComposerDisplayText, taskComposerInstruction, taskComposerDisplayText,
  parsePluginComposerMention, pluginComposerDisplayText, type ComposerMentionKind,
} from "./mention-encoding";
import { workspaceAttachmentInstruction, workspaceAttachmentDisplayText } from "./workspace-attachment";
import { parseSlashCommandInvocation } from "./slash-command";

export function buildComposerDraft(
  text: string,
  nextAttachments: ComposerAttachment[],
  mentions: Record<string, ComposerMentionKind>,
  pasteParts: readonly ComposerPastePart[],
): ComposerDraft {
  const effectiveMentions = { ...mentions };
  const modelContexts: string[] = [];
  let hasIntegrationSelection = false;
  const parts: ComposerPart[] = text.split(/(\[pasted text [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/).flatMap<ComposerPart>((segment) => {
    if (!segment) return [];
    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch) {
      const target = pasteParts.find((item) => item.label === pasteMatch[1]);
      if (target) {
        return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines }];
      }
    }
    const skillMatch = segment.match(/^\[skill (.+)\]$/);
    if (skillMatch?.[1]) {
      return [{ type: "skill", name: skillMatch[1] } satisfies ComposerDraft["parts"][number]];
    }
    if (segment.startsWith("@")) {
      const value = decodeComposerMentionValue(segment.slice(1));
      const kind = effectiveMentions[value] ?? (parsePluginComposerMention(value) ? "plugin" : parseIntegrationMention(value) ? "integration" : undefined);
      if (kind === "plugin" || kind === "integration") effectiveMentions[value] = kind;
      if (kind === "integration" && parseIntegrationMention(value)) {
        hasIntegrationSelection = true;
        modelContexts.push(integrationInstruction(value));
        return [{ type: "text", text: integrationDisplayText(value) }];
      }
      if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
      if (kind === "plugin") {
        const plugin = parsePluginComposerMention(value);
        if (plugin) return [{ type: "plugin", ...plugin } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
      if (kind === "upload") {
        modelContexts.push(workspaceAttachmentInstruction(value));
        return [{ type: "text", text: workspaceAttachmentDisplayText(value) } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "memory") {
        modelContexts.push(legalMemoryComposerInstruction(value));
        return [{ type: "text", text: legalMemoryComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "storage") {
        modelContexts.push(storageComposerInstruction(value));
        return [{ type: "text", text: storageComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "review") {
        modelContexts.push(reviewComposerInstruction(value));
        return [{ type: "text", text: reviewComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "calendar") {
        modelContexts.push(calendarComposerInstruction(value));
        return [{ type: "text", text: calendarComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "task") {
        modelContexts.push(taskComposerInstruction(value));
        return [{ type: "text", text: taskComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "app") return [{ type: "app", name: value } satisfies ComposerDraft["parts"][number]];
    }
    return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
  });
  // Expand paste placeholders in resolvedText so the model receives
  // the actual pasted content instead of "[pasted text <label>]".
  let resolved = text;
  for (const part of pasteParts) {
    resolved = resolved.replace(`[pasted text ${part.label}]`, () => part.text);
  }
  resolved = resolved.replace(/\[skill ([^\]]+)\]/g, (_match, name: string) => `the \"${name}\" skill`);
  for (const [value, kind] of Object.entries(effectiveMentions)) {
    resolved = resolved.replaceAll(
      `@${encodeComposerMentionValue(value)}`,
      kind === "integration"
        ? integrationDisplayText(value)
        : kind === "plugin"
        ? pluginComposerDisplayText(value)
        : kind === "memory"
        ? legalMemoryComposerDisplayText(value)
        : kind === "storage"
          ? storageComposerDisplayText(value)
          : kind === "review"
            ? reviewComposerDisplayText(value)
          : kind === "calendar"
            ? calendarComposerDisplayText(value)
          : kind === "task"
            ? taskComposerDisplayText(value)
            : kind === "upload"
              ? workspaceAttachmentDisplayText(value)
              : `@${value}`,
    );
  }
  const slashCommand = (parts.some(part => part.type === "plugin") || hasIntegrationSelection) ? null : parseSlashCommandInvocation(resolved);
  // Inline references are text fragments, not separate paragraphs. Keep their
  // original whitespace when the native transport joins prompt text parts.
  const mergedParts: ComposerPart[] = [];
  for (const part of parts) {
    const previous = mergedParts.at(-1);
    if (previous?.type === "text" && part.type === "text") previous.text += part.text;
    else mergedParts.push(part);
  }
  return {
    mode: "prompt",
    parts: mergedParts,
    attachments: nextAttachments,
    text,
    resolvedText: resolved,
    modelContext: [...new Set(modelContexts)].join("\n") || undefined,
    command: slashCommand ?? undefined,
  };
}
