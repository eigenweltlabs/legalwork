# Mail worker transport and supervision

This directory implements a private parent/worker transport. It does **not** implement a production database, mailbox sync, provider authentication or server route. `fixtures/worker.mjs` is deliberately a fault-injection test fixture; never configure it as the production worker entrypoint.

## Configuration

Create `MailWorkerClient` with a trusted absolute `entryPoint` pointing to a built worker JavaScript module, an explicit `executable: { kind: "node" | "electron", path: absolutePath }`, and an asynchronous `initialize()` supplier. Under Bun development, pass a separate compatible Node executable: **never use Bun's `process.execPath`**. The client probes the selected executable, rejects Bun and Node versions below 22, then spawns it directly without a shell. A Node-version probe establishes runtime family/version only; it does not establish native-addon ABI compatibility. The real worker must load/probe its selected encrypted database addon before sending ready.

Electron uses its own executable with `ELECTRON_RUN_AS_NODE=1`. This requires the packaged executable's RunAsNode fuse to remain enabled. Local validation used Electron 35.7.5 with embedded Node 22.16.0; packaged Windows/macOS/Linux builds still need their own artifact/ABI probes. The subprocess receives only platform-required SystemRoot/WINDIR and the Electron mode flag. It does not inherit tokens, NODE_OPTIONS, NODE_PATH, proxy settings or other parent environment. Any needed non-secret configuration should become an explicit reviewed field, not an environment passthrough.

`initialize()` is re-read for every launch, allowing the parent to retrieve current keychain credentials after a crash. It supplies `databasePath`, `encryptionKey` and optional provider credentials (account ID, gmail/graph, access/refresh token). These values travel exclusively through the child's private stdin pipe. They are never command arguments, environment, diagnostics or persisted by this transport. The supplier and the real worker own key validation, encrypted storage, identity isolation and credential refresh. JavaScript strings cannot promise deterministic memory zeroization; this transport keeps no durable secret store.

Defaults and hard bounds:

| Setting | Default | Accepted range |
| --- | --- | --- |
| Startup phase timeout | 10 seconds | 10 ms–60 seconds |
| Request timeout | 30 seconds | 10 ms–5 minutes |
| Graceful shutdown allowance | 3 seconds | 10 ms–30 seconds |
| Pending requests | 32 | 1–256 |
| Automatic restart attempts | 3 | 0–10 |
| Initial restart delay | 250 ms | 10 ms–30 seconds |
| Maximum restart delay | 5 seconds | initial delay–60 seconds |
| Frame payload size | 64 KiB | fixed |

Executable probing itself has a three-second timeout and a 1 KiB output cap. Preparation (probe + initialization supplier) and worker ready handshake each have a startup phase timeout. A hung supplier cannot prevent stop or run forever as a startup operation; the transport cannot cancel arbitrary work inside a caller's supplier, so suppliers should avoid side effects and implement their own cancellation where needed.

## Lifecycle

`start()` coalesces concurrent starts and resolves only after a valid version-1 ready message. The real worker must consume initialization, open/check encrypted storage, perform migrations and initialize handlers before emitting ready. A ready message asserts Node family/version, not production provider connectivity. The client never synthesizes ready.

`request(command)` requires ready state. Correlation IDs include the worker generation and sequence. Responses may arrive out of order; unknown IDs, wrong result types, malformed data, repeated readiness or oversized messages terminate that generation and reject its pending requests. Request timeouts likewise terminate the generation: a timed-out mutation has **unknown outcome**, and the transport never retries or replays it. The caller must reconcile against durable operation state/provider results before issuing another mutation.

Unexpected child close rejects pending calls. While desired, the supervisor schedules exponential restart delays capped at the configured maximum, with a finite attempt budget across successful/failed automatic launches. A healthy ready event does not reset that budget; explicit `start()` from a stopped/failed process starts a new budget. Calls during startup/backoff fail with a fixed not-ready error, rather than queueing or replaying operations. Await stop before explicitly starting again.

`stop()` cancels backoff/preparation, rejects pending requests, sends a private shutdown message and closes stdin. The real worker must stop accepting operations, flush/close its database and exit. If it does not exit during the configured allowance, the supervisor sends SIGKILL; it then waits for child close before resolving. As with OS process supervision generally, process reaping depends on the operating system. Do not spawn descendants that inherit the transport's stdio; descendant-held pipes can prevent close. No replacement is launched after stop.

## Protocol and integration

Frames are UTF-8 JSON followed by newline, with a 64 KiB payload cap excluding newline. stdout belongs exclusively to the protocol. Parent buffering and admitted requests are bounded; the real worker must enforce the same byte cap **before** accumulating/parsing input. Use `parseParentMessage` and `parseWorkerMessage` for strict schemas and reject malformed frames. Worker stderr is drained and discarded, never copied to logs: provider failures and paths can contain credentials or mailbox content.

Currently allowed requests are ping, account mail status, sync start/stop, and credentials update. Sync results acknowledge acceptance only; they are not a provider-operation completion contract. Status exposes only idle/syncing. Results must match the command. There is no SQL, arbitrary filesystem/network request or shell command. Trusted database location is startup configuration, not a remotely callable file operation. Unsupported requests should return the fixed `unsupported` error. Extend protocol unions, validators and tests intentionally when the real worker handlers and mailbox model support additional operations.

This channel is private to a parent-created process and is not a server authentication boundary. The parent must authenticate/authorize public routes, validate account ownership and translate narrow domain operations; never expose the transport directly as a remote command proxy. The real worker must independently validate frames and account scope. The root integration owns worker entrypoint build/packaging, addon selection, worker handlers, native storage startup/migrations, server auth/routes, and application shutdown hooks. Credentials update acknowledges delivery only after the handler has safely applied it; real refresh persistence still needs its own worker-to-parent/domain protocol.

Diagnostics contain only constant event/error codes and restart counts. `status()` returns lifecycle state, restarts and pending count. Neither includes supplied IDs, paths, tokens, keys, raw child output or provider error bodies. Diagnostic callback exceptions cannot interrupt cleanup.

## Verification

From the repository root:

```sh
LEGALWORK_MAIL_TEST_NODE=/absolute/path/to/node pnpm --dir apps/server exec bun test src/mail/runtime/client.test.ts
```

Fixture tests otherwise resolve a concrete `node` executable from PATH; production has no implicit executable fallback. To also exercise a real Electron executable, set `LEGALWORK_MAIL_TEST_ELECTRON=/absolute/path/to/Electron` for the same command. That test is explicitly skipped when no Electron path is supplied.

Validated under Bun 1.3.9 with Node 24.11.0 and Electron 35.7.5/Node 22.16.0: handshake/coalesced start, out-of-order correlation, crash rejection, lost responses, malformed/oversized/wrong responses, startup and supplier hangs, capped restart, stop during backoff, explicit restart, forced hung-shutdown termination, pending admission, outbound cap, secret-free diagnostics and strict command rejection. These tests use actual child processes but fake worker handlers; they do not validate native encryption, database recovery, packaged distribution or mail synchronization.
