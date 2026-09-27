import { describe, expect, test } from "bun:test";
import { serverSentEvents, syncPokeOf, type SyncPoke } from "@legalwork/types/sync-events";

import { announceSyncChange, syncEventStream } from "./app-sync-events.js";
import type { ServerConfig } from "./types.js";

function configAt(configPath: string): ServerConfig {
  return { configPath } as ServerConfig;
}

/** Open a window's stream and collect its events. */
function listen(config: ServerConfig) {
  const window = new AbortController();
  const events: SyncPoke[] = [];
  const body = syncEventStream(config, window.signal).body;
  if (!body) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const feed = serverSentEvents((data) => {
    const poke = syncPokeOf(data);
    if (poke) events.push(poke);
  });
  const ended = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      feed(decoder.decode(chunk.value, { stream: true }));
    }
  })();
  return { events, close: () => window.abort(), ended };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("app sync events", () => {
  test("a window hears a resync first, then changes, close together as one", async () => {
    const config = configAt("/tmp/app-sync-events-a.json");
    const stream = listen(config);
    await settle(10);
    expect(stream.events).toEqual([{ resync: true }]);

    announceSyncChange(config, "projects");
    announceSyncChange(config, "tasks");
    announceSyncChange(config, "projects");
    await settle(400);
    expect(stream.events).toEqual([{ resync: true }, { projects: true, tasks: true }]);

    announceSyncChange(config, "tasks");
    await settle(400);
    expect(stream.events.at(-1)).toEqual({ tasks: true });
    stream.close();
    await stream.ended;
  });

  test("only the windows of the same server hear it, and a closed one no more", async () => {
    const mine = configAt("/tmp/app-sync-events-b.json");
    const other = listen(configAt("/tmp/app-sync-events-c.json"));
    const closed = listen(mine);
    const open = listen(mine);
    await settle(10);
    closed.close();
    await closed.ended;

    announceSyncChange(mine, "tasks");
    await settle(400);
    expect(open.events).toEqual([{ resync: true }, { tasks: true }]);
    expect(closed.events).toEqual([{ resync: true }]);
    expect(other.events).toEqual([{ resync: true }]);
    open.close();
    other.close();
    await Promise.all([open.ended, other.ended]);
  });
});
