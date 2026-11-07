import { isNativeReviewWorker } from "./native-review-worker.js";
import type { Plugin } from "@opencode/plugin";
import type { Result } from "@opencode/plugin/promise/tool";

type History = Awaited<ReturnType<Plugin.Context["session"]["context"]>>;

type ReminderOptions = {
  topic: string;
  /** Empty means cleared; null means unknown, so previously reported state remains current. */
  read: (sessionID: string, directory: string) => Promise<string | null>;
  cleared: string;
  /** Clocks are snapshots at admission; tool results must replay that snapshot unchanged. */
  toolResults?: boolean;
};

function reminder(topic: string, state: string): string {
  return `<system-reminder topic="${topic}">\n${state}\n</system-reminder>`;
}

function latestState(history: History, topic: string): string | null {
  const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<system-reminder topic="${escapedTopic}">\\n([\\s\\S]*?)\\n</system-reminder>`, "g");
  let latest: string | null = null;
  const inspect = (text: string) => { for (const match of text.matchAll(pattern)) latest = match[1] ?? latest; };
  const marker = (metadata: unknown) => {
    if (!metadata || typeof metadata !== "object") return;
    const states: unknown = Reflect.get(metadata, "legalworkSystemReminders");
    if (!states || typeof states !== "object") return;
    const state: unknown = Reflect.get(states, topic);
    if (typeof state === "string") latest = state;
  };
  for (const message of history) {
    if (message.type === "compaction" && message.status === "completed") { latest = null; continue; }
    if (message.type === "user" || message.type === "synthetic" || message.type === "system") inspect(message.text);
    marker(message.metadata);
    if (message.type !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue;
      for (const content of part.state.content) if (content.type === "text") inspect(content.text);
      marker(part.state.metadata);
    }
  }
  return latest;
}

/**
 * Durable, chronological app context through the public V2 plugin API.
 * Fixed instructions stay in context hooks; live state never changes the system prefix.
 */
export async function registerAppStateReminders(ctx: Plugin.Context, options: ReminderOptions): Promise<() => void> {
  const reported = new Map<string, string>();
  const reset = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  const codeMode = new Map<string, Set<string>>();
  const controller = new AbortController();

  async function serial(sessionID: string, run: () => Promise<void>): Promise<void> {
    const previous = queues.get(sessionID) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(() => {}, () => {});
    queues.set(sessionID, settled);
    try { await next; }
    finally { if (queues.get(sessionID) === settled) queues.delete(sessionID); }
  }

  async function changed(sessionID: string, publish: (text: string, state: string) => Promise<void>, admission = false) {
    await serial(sessionID, async () => {
      if (await isNativeReviewWorker(ctx, sessionID)) return;
      const session = await ctx.session.get({ sessionID });
      if (admission || !reported.has(sessionID)) {
        // Read active history after restarts and reverts; never rewrite an older message.
        const history = await ctx.session.context({ sessionID }).catch(() => []);
        const last = reset.has(sessionID) ? null : latestState(history, options.topic);
        reported.set(sessionID, last === options.cleared ? "" : last ?? "");
        reset.delete(sessionID);
      }
      const state = await options.read(sessionID, session.location.directory);
      if (state === null || state === reported.get(sessionID)) return;
      await publish(reminder(options.topic, state || options.cleared), state);
      // A prompt draft is not admitted yet. Reload durable state on the next prompt,
      // so an attachment/preparation failure cannot suppress its retried reminder.
      if (admission) reported.delete(sessionID);
      else reported.set(sessionID, state);
    });
  }

  await ctx.session.hook("prompt", async (event) => {
    await changed(event.sessionID, async (text, state) => {
      const metadata = event.metadata ?? {};
      const previous: unknown = metadata.legalworkPrompt;
      const visible: unknown = previous && typeof previous === "object" ? Reflect.get(previous, "visibleText") : undefined;
      const prior: unknown = previous && typeof previous === "object" ? Reflect.get(previous, "reminders") : undefined;
      const reminders = Array.isArray(prior) ? prior.filter((item): item is string => typeof item === "string") : [];
      const states: unknown = metadata.legalworkSystemReminders;
      event.metadata = { ...metadata,
        legalworkPrompt: { visibleText: typeof visible === "string" ? visible : event.prompt.text, reminders: [...reminders, text] },
        legalworkSystemReminders: { ...(states && typeof states === "object" && !Array.isArray(states) ? Object.fromEntries(Object.entries(states)) : {}), [options.topic]: state },
      };
      event.prompt.text += `\n\n${text}`;
    }, true);
  });

  if (options.toolResults !== false) await ctx.tool.hook("execute.before", event => {
    if (event.tool !== "execute") return;
    const key = `${event.sessionID}:${event.messageID}`;
    const running = codeMode.get(key) ?? new Set<string>();
    running.add(event.id); codeMode.set(key, running);
  });

  if (options.toolResults !== false) await ctx.tool.hook("execute.after", async (event) => {
    const key = `${event.sessionID}:${event.messageID}`;
    const running = codeMode.get(key);
    if (event.tool === "execute") {
      running?.delete(event.id);
      if (!running?.size) codeMode.delete(key);
    } else if (running?.size) {
      // Code Mode returns a child's typed output, discarding its text/metadata.
      // Publish live app context on the durable outer result instead.
      return;
    }
    if (event.status !== "completed") return;
    await changed(event.sessionID, async (text, state) => {
      const content: Exclude<Result["content"], string | undefined> = typeof event.result.content === "string" ? [{ type: "text", text: event.result.content }]
        : event.result.content ?? [];
      const previous: unknown = event.result.metadata?.legalworkSystemReminders;
      const reminders = previous && typeof previous === "object" && !Array.isArray(previous)
        ? Object.fromEntries(Object.entries(previous)) : {};
      event.result = { ...event.result,
        // Keep the reminder ahead of large connector output that the engine may shorten.
        content: [{ type: "text", text }, ...content],
        metadata: { ...event.result.metadata,
          legalworkSystemReminders: { ...reminders, [options.topic]: state } },
      };
    });
  });

  // Plugin streams are live-only. On recovery, reload durable history instead of trusting stale memory.
  void (async () => {
    let delay = 100;
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          delay = 100;
          if (event.type === "server.connected") { reported.clear(); continue; }
          if (event.type !== "session.compaction.ended" && event.type !== "session.revert.staged"
            && event.type !== "session.revert.cleared" && event.type !== "session.revert.committed"
            && event.type !== "session.moved" && event.type !== "session.deleted") continue;
          const sessionID = event.data.sessionID;
          reported.delete(sessionID);
          if (event.type === "session.compaction.ended") reset.add(sessionID);
        }
      } catch {
        reported.clear();
      }
      if (controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, delay);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
      delay = Math.min(delay * 2, 2_000);
    }
  })();

  return () => controller.abort();
}
