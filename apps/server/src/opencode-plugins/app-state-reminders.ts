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
 * <system-reminder topic="…"> on the next user message, or on the next tool
 * result during a run, and only when it changed. The latest reminder on a
 * topic is the current state. Saved history is never rewritten, so
 * everything before the newest message stays cached.
 *
 * What was last reported is read back from the saved conversation, so after
 * an engine restart a change is neither repeated nor missed.
 *
 * Plugins are bundled standalone, so each plugin holds its own instance.
 */

/** The current state as text: "" when there is nothing to report, null when it could not be read. */
export type ReadAppState = (sessionID: string) => Promise<string | null>;

type SavedPart = { type: string; text?: string; state?: { status: string; output?: string } };

/** The plugin input's engine client, as far as needed to read a conversation's saved messages. */
export type SavedConversations = {
  client?: {
    session?: {
      messages(options: { path: { id: string }; query: { directory?: string } }): Promise<{ data?: { parts: SavedPart[] }[] }>;
    };
  };
  directory?: string;
};

type UserMessage = { message: { id: string }; parts: object[] };
type PluginEvent = { event: { type: string; properties?: unknown } };

/** The session a "session.compacted" event belongs to, or null for any other event. */
export function compactedSessionID({ event }: PluginEvent): string | null {
  if (event.type !== "session.compacted" || typeof event.properties !== "object" || event.properties === null) return null;
  const sessionID = Reflect.get(event.properties, "sessionID");
  return typeof sessionID === "string" ? sessionID : null;
}

export function systemReminder(topic: string, text: string): string {
  return `<system-reminder topic="${topic}">\n${text}\n</system-reminder>`;
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

/** The text of the latest saved reminder on a topic since the last compaction; null when there is none. */
function latestReminder(messages: { parts: SavedPart[] }[], topic: string): string | null {
  // A compaction summary may have dropped earlier reminders, so they no longer count.
  const compacted = messages.map((message) => message.parts.some((part) => part.type === "compaction")).lastIndexOf(true);
  const pattern = new RegExp(`<system-reminder topic="${topic}">\\n([\\s\\S]*?)\\n</system-reminder>`, "g");
  let latest: string | null = null;
  for (const message of messages.slice(compacted + 1)) {
    for (const part of message.parts) {
      const text = part.type === "text" ? part.text : part.type === "tool" && part.state?.status === "completed" ? part.state.output : undefined;
      for (const match of text?.matchAll(pattern) ?? []) latest = match[1] ?? latest;
    }
  }
  return latest;
}

/**
 * @param topic  names the reminders; the latest one on a topic replaces earlier ones
 * @param read  current state for a session
 * @param cleared  reported once when the state becomes empty again
 * @param saved  the plugin input, to continue from the saved conversation after a restart
 */
export function appStateReminders(topic: string, read: ReadAppState, cleared: string, saved: SavedConversations = {}) {
  const reported = new Map<string, string>();
  const loading = new Map<string, Promise<void>>();

  const load = async (sessionID: string) => {
    let state = "";
    try {
      const { data } = (await saved.client?.session?.messages({ path: { id: sessionID }, query: { directory: saved.directory } })) ?? {};
      const latest = data ? latestReminder(data, topic) : null;
      if (latest !== null && latest !== cleared) state = latest;
    } catch {
      // Unreadable history: continue as if nothing had been reported.
    }
    if (!reported.has(sessionID)) reported.set(sessionID, state);
  };

  const change = async (sessionID: string) => {
    // Parallel tool calls share one lookup, so a change is reported once.
    const pending = reported.has(sessionID) ? undefined : (loading.get(sessionID) ?? load(sessionID).finally(() => loading.delete(sessionID)));
    if (pending) loading.set(sessionID, pending);
    const [state] = await Promise.all([read(sessionID), pending]);
    if (state === null || state === reported.get(sessionID)) return null;
    reported.set(sessionID, state);
    return systemReminder(topic, state || cleared);
  };

  return {
    /** "chat.message": the user's new message carries what changed since the last turn. */
    async userMessage(input: { sessionID: string }, output: UserMessage) {
      const text = await change(input.sessionID);
      if (text) {
        output.parts.push({ id: partId(), sessionID: input.sessionID, messageID: output.message.id, type: "text", text, synthetic: true });
      }
    },
    /**
     * "tool.execute.after": a change during a run rides on the next tool result.
     * Engine and plugin tool output is already shortened, so the reminder goes
     * last. Connector (MCP) content is joined and shortened from the end after
     * this hook, so the reminder goes first.
     */
    async toolResult(input: { sessionID?: string }, output: { output?: unknown; content?: unknown }) {
      if (!input.sessionID || (typeof output.output !== "string" && !Array.isArray(output.content))) return;
      const text = await change(input.sessionID);
      if (!text) return;
      if (typeof output.output === "string") output.output = `${output.output}\n\n${text}`;
      else if (Array.isArray(output.content)) output.content.unshift({ type: "text", text });
    },
    /** "event": a compaction summary may drop earlier reminders, so the state is reported again. */
    event(input: PluginEvent) {
      const sessionID = compactedSessionID(input);
      if (sessionID) reported.set(sessionID, "");
    },
  };
}
