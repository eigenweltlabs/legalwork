/**
 * Live app state for the model, without touching the system prompt.
 *
 * Providers reuse a cached prompt only as far as a request matches the
 * previous one from the start, and the system prompt comes first. A system
 * prompt that changes between steps therefore discards the cache for the
 * whole conversation: measured through the Eigenwelt gateway on Gemini, a run
 * cached 0% of each step instead of ~85%.
 *
 * So plugins keep their system text fixed and report live state (open files,
 * Office panes, project details) into the conversation instead: as a
 * <system-reminder> on the next user message, or on the next tool result
 * during a run, and only when it changed. Saved history is never rewritten,
 * so everything before the newest message stays cached.
 *
 * Plugins are bundled standalone, so each plugin holds its own instance.
 */

/** The current state as text: "" when there is nothing to report, null when it could not be read. */
export type ReadAppState = (sessionID: string) => Promise<string | null>;

type UserMessage = { message: { id: string }; parts: object[] };
type PluginEvent = { event: { type: string; properties?: unknown } };

/** The session a "session.compacted" event belongs to, or null for any other event. */
export function compactedSessionID({ event }: PluginEvent): string | null {
  if (event.type !== "session.compacted" || typeof event.properties !== "object" || event.properties === null) return null;
  const sessionID = Reflect.get(event.properties, "sessionID");
  return typeof sessionID === "string" ? sessionID : null;
}

export function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTime = 0;
let counter = 0;

/** An ascending part ID in the engine's format, so the reminder sorts after the user's own parts. */
function partId(): string {
  const now = Date.now();
  counter = now === lastTime ? counter + 1 : 1;
  lastTime = now;
  const time = (BigInt(now) * BigInt(0x1000) + BigInt(counter)).toString(16).padStart(12, "0").slice(-12);
  let random = "";
  for (let i = 0; i < 14; i++) random += BASE62[Math.floor(Math.random() * BASE62.length)];
  return `prt_${time}${random}`;
}

/**
 * @param read  current state for a session
 * @param cleared  reported once when the state becomes empty again
 */
export function appStateReminders(read: ReadAppState, cleared: string) {
  const reported = new Map<string, string>();
  const change = async (sessionID: string) => {
    const state = await read(sessionID);
    if (state === null || state === (reported.get(sessionID) ?? "")) return null;
    reported.set(sessionID, state);
    return systemReminder(state || cleared);
  };
  return {
    /** "chat.message": the user's new message carries what changed since the last turn. */
    async userMessage(input: { sessionID: string }, output: UserMessage) {
      const text = await change(input.sessionID);
      if (text) {
        output.parts.push({ id: partId(), sessionID: input.sessionID, messageID: output.message.id, type: "text", text, synthetic: true });
      }
    },
    /** "tool.execute.after": a change during a run rides on the next tool result. */
    async toolResult(input: { sessionID?: string }, output: { output?: unknown }) {
      if (!input.sessionID || typeof output.output !== "string") return;
      const text = await change(input.sessionID);
      if (text) output.output = `${output.output}\n\n${text}`;
    },
    /** "event": a compaction summary may drop earlier reminders, so the state is reported again. */
    event(input: PluginEvent) {
      const sessionID = compactedSessionID(input);
      if (sessionID) reported.delete(sessionID);
    },
  };
}
