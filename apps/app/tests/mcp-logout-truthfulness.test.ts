import { describe, expect, test } from "bun:test";

import { detectReconnectWithoutAuth, type McpStatusSnapshot } from "../src/app/mcp-auth-state";

/**
 * Issue #86: a connector shows Ready without anyone signing in, "Log out"
 * reports success, and after a restart it is Ready again — which reads as a
 * stale session surviving the logout.
 *
 * A server can accept an unauthenticated handshake while its tools require
 * credentials. Reconnecting after logout tells us about the transport, not
 * whether credentials existed or whether tool calls will work.
 */

const noWait = async () => {};

const statuses = (status: string | undefined): McpStatusSnapshot =>
  status === undefined ? {} : { "iron-crow": { status } };

const detect = (reads: Array<McpStatusSnapshot | null>, overrides: Record<string, unknown> = {}) => {
  let index = 0;
  return detectReconnectWithoutAuth({
    serverName: "iron-crow",
    reconnect: async () => true,
    readStatus: async () => reads[Math.min(index++, reads.length - 1)] ?? null,
    wait: noWait,
    ...overrides,
  });
};

describe("logout truthfulness", () => {
  test("a transport can reconnect after credentials are removed", async () => {
    expect(await detect([statuses("connected")])).toBe(true);
  });

  test("a reconnect a beat later is still a reconnect", async () => {
    expect(await detect([statuses("disabled"), statuses("disabled"), statuses("connected")])).toBe(true);
  });

  test("a server asking to sign in again means the logout worked", async () => {
    expect(await detect([statuses("needs_auth")])).toBe(false);
  });

  test("needs_client_registration also means the logout worked", async () => {
    expect(await detect([statuses("needs_client_registration")])).toBe(false);
  });

  test("never reaching connected within the probe means the logout worked", async () => {
    expect(await detect([statuses("disabled")])).toBe(false);
  });

  test("needs_auth is terminal — a later connect does not overturn it", async () => {
    expect(await detect([statuses("needs_auth"), statuses("connected")])).toBe(false);
  });

  test("the probe must actually reconnect before judging", async () => {
    let reconnected = false;
    await detect([statuses("connected")], {
      reconnect: async () => {
        reconnected = true;
        return true;
      },
    });
    expect(reconnected).toBe(true);
  });

  test("a reconnect the engine refuses falls back to the ordinary message", async () => {
    expect(
      await detect([statuses("connected")], {
        reconnect: async () => {
          throw new Error("McpServerNotFoundError");
        },
      }),
    ).toBe(false);
  });

  test("an unreadable status falls back to the ordinary message", async () => {
    expect(await detect([null])).toBe(false);
    expect(
      await detectReconnectWithoutAuth({
        serverName: "iron-crow",
        reconnect: async () => true,
        readStatus: async () => {
          throw new Error("engine unavailable");
        },
        wait: noWait,
      }),
    ).toBe(false);
  });

  test("a server missing from the snapshot is not a silent reconnect", async () => {
    expect(await detect([statuses(undefined)])).toBe(false);
  });

  test("cancellation stops the probe without accusing the logout", async () => {
    expect(await detect([statuses("connected")], { isCancelled: () => true })).toBe(false);
  });

  test("each snapshot is handed back so the caller can refresh its badges", async () => {
    const seen: McpStatusSnapshot[] = [];
    await detect([statuses("disabled"), statuses("connected")], {
      onStatus: (s: McpStatusSnapshot) => seen.push(s),
    });
    expect(seen.length).toBe(2);
    expect(seen[1]?.["iron-crow"]?.status).toBe("connected");
  });
});
