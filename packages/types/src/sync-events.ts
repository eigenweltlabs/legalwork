import { z } from "zod";

/**
 * A sync event says only that projects, tasks, the firm's policy or its hub changed; whoever hears it
 * pulls, or re-reads, what changed. `resync` comes first on every
 * connection: what happened before it may have been missed. The platform
 * sends them to a LegalWork server (GET /api/sync/events), and a LegalWork
 * server to the app windows showing it (GET /sync/events).
 */
const SyncPokeSchema = z.object({
  projects: z.boolean().optional(),
  tasks: z.boolean().optional(),
  policy: z.boolean().optional(),
  hub: z.boolean().optional(),
  sessions: z.boolean().optional(),
  resync: z.boolean().optional(),
});
export type SyncPoke = z.infer<typeof SyncPokeSchema>;

/** An event's data as a sync event, or null when it is none. */
export function syncPokeOf(data: string): SyncPoke | null {
  try {
    const poke = SyncPokeSchema.safeParse(JSON.parse(data));
    return poke.success ? poke.data : null;
  } catch {
    return null;
  }
}

/** Feed it a server-sent event stream's text as it comes; it hands on each event's data. */
export function serverSentEvents(onData: (data: string) => void): (text: string) => void {
  let buffer = "";
  return (text) => {
    buffer += text.replace(/\r\n?/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const lines = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
      if (data.length > 0) onData(data.join("\n"));
    }
  };
}
