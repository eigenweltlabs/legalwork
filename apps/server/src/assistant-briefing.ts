import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { MORNING_BRIEFING_PROMPT } from "./assistant-schema.js";
import { localSessionDatabasePath } from "./content-search.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import { isMainAssistant, type MainAssistant } from "./main-assistant.js";
import { wallTime } from "./scheduled-tasks/schedule.js";
import type { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const MORNING_BRIEFING_KEY = "assistant-morning-briefing";

/** Stop at six root chats. Empty, automatically-created Assistant days do not count. */
export async function hasBriefingSessionThreshold(config: ServerConfig, accessible: (id: string) => Promise<WorkspaceInfo>) {
  const path = localSessionDatabasePath(config);
  if (!existsSync(path)) return false;
  const db = await openSqliteReadonly(path);
  const sessions = new Set<string>();
  try {
    for (const entry of config.workspaces) {
      if (entry.workspaceType === "remote") continue;
      let workspace: WorkspaceInfo;
      try { workspace = await accessible(entry.id); } catch { continue; }
      const root = workspace.opencode?.directory || workspace.directory || workspace.path;
      const canonical = await realpath(root).catch(() => resolve(root));
      const rows = db.all(`SELECT s.id FROM session s WHERE s.directory IN (?, ?) AND s.parent_id IS NULL
        AND (? = '0' OR EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user')) LIMIT 6`,
      [root, canonical, isMainAssistant(workspace) ? "1" : "0"]);
      for (const row of rows) sessions.add(String(row.id));
      if (sessions.size > 5) return true;
    }
    return false;
  } finally { db.close(); }
}

export async function ensureMorningBriefing(config: ServerConfig, store: ScheduledTaskStore, assistant: Pick<MainAssistant, "workspace">,
  eligible: () => Promise<boolean>, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (config.readOnly) return null;
  // Original preset with ambiguous "Browse every ... page" instructions.
  store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, "c8a6f6e04d4d2487179763bf592a35686c05209332b719b1d2488fc246009ba4", MORNING_BRIEFING_PROMPT, now);
  if (store.hasDefault(MORNING_BRIEFING_KEY) || !await eligible()) return null;
  const workspace = await assistant.workspace();
  return store.createDefault(MORNING_BRIEFING_KEY, workspace.id, {
    title: "Morning briefing", prompt: MORNING_BRIEFING_PROMPT,
    schedule: { kind: "rrule", startAt: `${wallTime(new Date(now).toISOString(), timeZone).slice(0, 10)}T06:00:00`, timeZone, rrule: "FREQ=DAILY" },
    projectAccess: "all", sessionId: null, reuseChat: false, pinSession: false, model: null,
  }, now);
}
