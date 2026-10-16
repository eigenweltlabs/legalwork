# Session stop isolation investigation

Status: unresolved. The current baseline does not reproduce a stop propagating
to unrelated chats. This change adds regression coverage and an isolated engine
reproduction harness; it does not change runtime cancellation behavior.

Baseline: `dev` at `e9476b46`, OpenCode `1.18.29`, macOS arm64, Bun `1.3.9`.

The shipped engine test starts two temporary project directories and a local
synthetic streaming provider. Parent A and a sibling run in the first project;
parent B runs in the second. Both parents launch real background subagents with
the engine's `task` tool and `background: true`, using the same experimental flag
LegalWork enables. Aborting A stops A and its child. The sibling, B, and B's child
remain busy, receive further output, and finish normally. Persisted transcripts
contain text generated after A stopped.

The app event regression checks that A's abort and idle events do not mark other
chats idle or pause their queues, and that their transcripts continue updating.
The server queue regression checks that pausing A leaves other chats able to
finish and dispatch their next message, including a different project's queue
with the same synthetic session key. Existing subagent-stop and shared-VM
cancellation tests also pass.

Run from the repository root with dependencies installed:

```sh
OPENCODE_TEST_BINARY="/path/to/shipped/opencode" pnpm exec bun test apps/server/scripts/session-stop-engine.test.ts
pnpm --dir apps/app exec bun test tests/session-sync-abort.test.ts tests/stop-subagent.test.ts
pnpm --dir apps/server exec bun test src/session-message-queue.test.ts src/agent-sandbox/runtime.test.ts
```

The integration test skips without `OPENCODE_TEST_BINARY` and checks the supplied
binary's version against `constants.json`. It uses fresh configuration, data,
cache, and state directories, with no model account or active app session.

Remaining reproduction work:

1. Repeat in the full desktop app with two independent projects, a sibling chat,
   and background subagents. Test both the Stop button and Escape confirmation,
   including multiple windows and a pending connector or configuration change.
2. Record the app and engine versions, OS, whether sandboxing is enabled, and
   whether the affected chats share a parent or are independent. Record relative
   timings and synthetic identifiers rather than conversation content.
3. Correlate the selected chat's queue pause and `/session/{id}/abort` request
   (including its directory scope) with every affected chat's `session.status`,
   `session.idle`, and `session.error` events. Distinguish a changed UI indicator
   from an actual model/tool cancellation.
4. Check for `/instance/dispose`, `/workspace/{id}/engine/reload`, configuration
   reload events, and engine exit/restart logs immediately after Stop. The UI's
   reload coordinator waits for active runs, but a full-app race is not covered
   by the direct engine harness. If protected commands are active, also check
   for `Protected command cancellation timed out.` and VM shutdown diagnostics.

No rendered desktop reproduction or screen recording is included. The harness
exercises the real engine directly; app event and queue behavior are tested
separately. A failing full-app trace is needed before selecting a runtime fix.
