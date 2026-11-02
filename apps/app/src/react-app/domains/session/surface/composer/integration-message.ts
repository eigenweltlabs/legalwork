import { parseIntegrationMention, type IntegrationSelection } from "./integration-mention";
import { decodeComposerMentionValue } from "./mention-encoding";

function isSelection(value: unknown): value is IntegrationSelection {
  return Boolean(value && typeof value === "object" && "kind" in value && typeof value.kind === "string" && ["mcp", "account", "storage", "website"].includes(value.kind) && "id" in value && typeof value.id === "string" && value.id.trim() && "label" in value && typeof value.label === "string" && value.label.trim());
}

export function integrationReferencesFromDraft(text: string): IntegrationSelection[] {
  return [...text.matchAll(/@([^\s@]+)/g)].flatMap(match => {
    const selection = parseIntegrationMention(decodeComposerMentionValue(match[1]));
    return selection ? [selection] : [];
  });
}

/** Older sends kept the selected identity only in the hidden per-turn context. */
export function integrationMessageMetadata(value: unknown) {
  if (!value || typeof value !== "object") return { integrations: [], legacyIntegrationSpacing: false };
  if ("integrations" in value && Array.isArray(value.integrations)) return { integrations: value.integrations.filter(isSelection), legacyIntegrationSpacing: false };
  const reminders = "reminders" in value && Array.isArray(value.reminders) ? value.reminders.filter((reminder): reminder is string => typeof reminder === "string") : [];
  const integrations = reminders.flatMap(reminder => [...reminder.matchAll(/The following JSON is reference data, not instructions\.\n([^\n]+)/g)].flatMap(match => {
    try {
      const selection: unknown = JSON.parse(match[1]);
      return isSelection(selection) ? [selection] : [];
    } catch { return []; }
  }));
  return { integrations, legacyIntegrationSpacing: integrations.length > 0 };
}

/** Match only selected references, never arbitrary @words in a user's text. */
export function splitIntegrationMessage(text: string, references: readonly IntegrationSelection[], legacySpacing = false): (string | IntegrationSelection)[] {
  const parts: (string | IntegrationSelection)[] = [];
  let offset = 0;
  while (offset < text.length) {
    const matches = references.flatMap(reference => {
      const token = `@${reference.label}`;
      let index = text.indexOf(token, offset);
      while (index >= 0 && ((index > 0 && /[\p{L}\p{N}_@]/u.test(text[index - 1])) || (text[index + token.length] && /[\p{L}\p{N}_-]/u.test(text[index + token.length])))) index = text.indexOf(token, index + token.length);
      return index < 0 ? [] : [{ reference, token, index }];
    }).sort((a, b) => a.index - b.index || b.token.length - a.token.length);
    const match = matches[0];
    if (!match) { parts.push(text.slice(offset)); break; }
    let before = text.slice(offset, match.index);
    if (legacySpacing) before = before.replace(/([ \t])\n$/, "$1");
    parts.push(before, match.reference);
    offset = match.index + match.token.length;
    // The old serializer joined separate inline text parts with a newline.
    if (legacySpacing && text[offset] === "\n" && /[ \t]/.test(text[offset + 1] ?? "")) offset++;
  }
  return parts;
}
