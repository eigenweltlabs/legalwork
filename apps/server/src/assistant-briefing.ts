import { MORNING_BRIEFING_PROMPT } from "./assistant-schema.js";
import type { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import type { ServerConfig } from "./types.js";

export const MORNING_BRIEFING_KEY = "assistant-morning-briefing";

/** Upgrade existing untouched presets. Scheduling always requires a human request. */
export function migrateMorningBriefing(config: ServerConfig, store: ScheduledTaskStore, now = Date.now()) {
  if (config.readOnly) return;
  // Original preset with ambiguous "Browse every ... page" instructions.
  store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, "c8a6f6e04d4d2487179763bf592a35686c05209332b719b1d2488fc246009ba4", MORNING_BRIEFING_PROMPT, now);
  // Upgrade the unchanged direct-tools preset; preserve custom prompts and scheduling.
  store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, "a91ee6685df2c1e10ceabd4c80c004bc8fa1d297863c741e77b156909ba36726", MORNING_BRIEFING_PROMPT, now);
  store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, "5cdade5daef003fc8a906150f7375b426a6bf94fb32fb09f762b36f9512652f6", MORNING_BRIEFING_PROMPT, now);
  // Keep source files on task attachments when upgrading the unchanged preset.
  store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, "099b22c8c59feb1f5f8de93c0f435bae502ffea167a862cea50c13cdbd84f38d", MORNING_BRIEFING_PROMPT, now);
}
