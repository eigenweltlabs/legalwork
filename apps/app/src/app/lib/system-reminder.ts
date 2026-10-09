import type { TextPartInput } from "@opencode-ai/sdk/v2/client";

/**
 * Context for one turn (attachment instructions, environment variable names,
 * the Fusion trace), sent as a hidden part of the user's message.
 *
 * Not as the prompt's `system` field: the engine appends that to the system
 * prompt, which then changes from turn to turn and discards the provider's
 * prompt cache for the whole conversation. A message part is saved with the
 * turn, so every later request repeats it unchanged. The chat view hides
 * synthetic parts.
 */
export function systemReminderPart(text: string): TextPartInput {
  return { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>`, synthetic: true };
}
