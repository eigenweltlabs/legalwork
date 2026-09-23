import { describe, expect, test } from "bun:test";

import { markTaskRunStart, takeTaskRunStart } from "../src/app/lib/analytics";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import {
  __RUN_STATS_VERSION_FOR_TEST as RUN_STATS_VERSION,
  __runStatsFromSnapshotForTest as runStatsFromSnapshot,
} from "../src/react-app/domains/session/sync/session-sync";

type Message = LegalworkSessionSnapshot["messages"][number];

function user(id: string): Message {
  return {
    info: { id, sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "klug-digital", modelID: "gpt-5.4" } },
    parts: [],
  } as unknown as Message;
}

/** One engine step: the assistant message plus its tool / step-finish parts. */
function step(
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  options: { cost?: number; toolCalls?: number } = {},
): Message {
  const parts = [
    ...Array.from({ length: options.toolCalls ?? 0 }, (_, index) => ({ type: "tool", id: `${id}-tool-${index}` })),
    { type: "step-finish", id: `${id}-finish` },
  ];
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 2, completed: 3 },
      cost: options.cost ?? 0,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.read, write: tokens.write },
      },
    },
    parts,
  } as unknown as Message;
}

const snapshot = (messages: Message[]) => ({ messages }) as unknown as LegalworkSessionSnapshot;

describe("runStatsFromSnapshot", () => {
  test("sums every assistant message in the run, not just the last", () => {
    // The v1 bug: an agentic turn is many engine steps, and reading only the
    // final one reported 40 input tokens for a run that actually spent 30,040.
    const stats = runStatsFromSnapshot(
      snapshot([
        user("u1"),
        step("a1", { input: 10_000, output: 200, reasoning: 500, read: 2_000, write: 100 }, { cost: 0.1, toolCalls: 2 }),
        step("a2", { input: 20_000, output: 300, reasoning: 700, read: 4_000, write: 0 }, { cost: 0.2, toolCalls: 1 }),
        step("a3", { input: 40, output: 120, reasoning: 0, read: 6_000, write: 0 }, { cost: 0.05 }),
      ]),
    );

    expect(stats).toEqual({
      tokens_input: 30_040,
      tokens_output: 620,
      tokens_reasoning: 1_200,
      tokens_cache_read: 12_000,
      tokens_cache_write: 100,
      cost_usd: 0.35,
      tool_call_count: 3,
      turn_count: 3,
      message_count: 3,
    });
  });

  test("counts only the latest run, leaving earlier turns to their own event", () => {
    const stats = runStatsFromSnapshot(
      snapshot([
        user("u1"),
        step("a1", { input: 99_000, output: 9_000, reasoning: 900, read: 900, write: 900 }, { cost: 9 }),
        user("u2"),
        step("a2", { input: 10, output: 20, reasoning: 30, read: 40, write: 50 }, { cost: 0.5 }),
      ]),
    );

    expect(stats).toMatchObject({ tokens_input: 10, tokens_output: 20, cost_usd: 0.5, message_count: 1 });
  });

  test("keeps the engine's non-overlapping token buckets separate", () => {
    // Billing treats cached reads and reasoning at their own rates, so they
    // must never be folded into input / output.
    const stats = runStatsFromSnapshot(
      snapshot([user("u1"), step("a1", { input: 1, output: 2, reasoning: 4, read: 8, write: 16 })]),
    );

    expect(stats).toMatchObject({
      tokens_input: 1,
      tokens_output: 2,
      tokens_reasoning: 4,
      tokens_cache_read: 8,
      tokens_cache_write: 16,
    });
  });

  test("tolerates messages the engine sent without token or cost fields", () => {
    const bare = { info: { id: "a1", sessionID: "ses_1", role: "assistant", time: { created: 2 } }, parts: [] } as unknown as Message;
    expect(runStatsFromSnapshot(snapshot([user("u1"), bare]))).toMatchObject({
      tokens_input: 0,
      tokens_reasoning: 0,
      cost_usd: 0,
      message_count: 1,
    });
  });

  test("sums from the top when the run has no user message to anchor on", () => {
    expect(runStatsFromSnapshot(snapshot([step("a1", { input: 5, output: 1, reasoning: 0, read: 0, write: 0 })])))
      .toMatchObject({ tokens_input: 5, message_count: 1 });
  });

  test("returns null when the run produced no assistant message", () => {
    expect(runStatsFromSnapshot(snapshot([user("u1")]))).toBeNull();
    expect(runStatsFromSnapshot(undefined)).toBeNull();
  });

  test("ships a version tag so v1's undercounted rows stay separable", () => {
    expect(RUN_STATS_VERSION).toBe(2);
  });
});

describe("run-start marker", () => {
  // The marker is what guarantees one stats-bearing event per run. The stop
  // button, session.idle and session.error all race to claim it; whoever wins
  // reports the tokens and the losers stay silent, so a stopped run is
  // neither double-counted nor dropped.
  test("only the first claimant gets the run", () => {
    markTaskRunStart("ses_race");
    expect(takeTaskRunStart("ses_race")).toBeNumber();
    expect(takeTaskRunStart("ses_race")).toBeNull();
  });

  test("a run this client never instrumented is not claimable", () => {
    expect(takeTaskRunStart("ses_never_started")).toBeNull();
  });

  test("runs are tracked per session", () => {
    markTaskRunStart("ses_a");
    markTaskRunStart("ses_b");
    expect(takeTaskRunStart("ses_a")).toBeNumber();
    expect(takeTaskRunStart("ses_b")).toBeNumber();
  });
});
