# Mail worker transport and supervision

This directory implements private worker transport and the production `worker.ts` entrypoint. The production worker opens the encrypted database, migrates its schema, binds a repository to one trusted owner and serves bounded account/folder reads. Mailbox synchronization, provider authentication and server routes are not implemented here. `fixtures/worker.mjs` is deliberately a fault-injection test fixture; never configure it as the production worker entrypoint.

## Configuration

Create `MailWorkerClient` with a trusted absolute `entryPoint` pointing to a built worker JavaScript module, an explicit `executable: { kind: "node" | "electron", path: absolutePath }`, and an asynchronous `initialize()` supplier. Under Bun development, pass a separate compatible Node executable: **never use Bun's `process.execPath`**. The client probes the selected executable, rejects Bun, Node versions below 22 and Node-API versions below 10, then spawns it directly without a shell. A Node-version probe establishes runtime family/version only; it does not establish native-addon ABI compatibility. The production worker loads/probes its selected encrypted database addon before sending ready.

Electron uses its own executable with `ELECTRON_RUN_AS_NODE=1`. This requires the packaged executable's RunAsNode fuse to remain enabled. Local validation used Electron 35.7.5 with embedded Node 22.16.0; packaged Windows/macOS/Linux builds still need their own artifact/ABI probes. The subprocess receives only platform-required SystemRoot/WINDIR and the Electron mode flag. It does not inherit tokens, NODE_OPTIONS, NODE_PATH, proxy settings or other parent environment. Any needed non-secret configuration should become an explicit reviewed field, not an environment passthrough.

`initialize()` is re-read for every launch, allowing the parent to retrieve current keychain credentials after a crash. Production initialization requires `ownerId`, absolute `databasePath`, and `encryptionKey` encoded as canonical base64 of exactly 32 bytes. `ownerId` comes from the desktop/authenticated service's stable principal, never an HTTP body, query, client header or account ID. Provider credential fields remain reserved in the protocol; the production worker rejects nonempty startup credentials until a real provider integration owns their handling. These values travel exclusively through the child's private stdin pipe. They are never command arguments, environment, diagnostics or persisted by this transport. The worker validates canonical key encoding, passes a decoded Buffer to the fail-closed encrypted opener, clears that Buffer, migrates the schema and binds `MailRepository` to the supplied owner. The supplier owns key retrieval; provider credential refresh remains unimplemented. JavaScript strings cannot promise deterministic memory zeroization; this transport keeps no durable secret store.

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

`start()` coalesces concurrent starts and resolves only after a valid version-1 ready message. The production worker consumes initialization, verifies/opens encrypted storage and migrates before emitting ready. Missing/malformed/wrong keys and native load/migration failures emit only a fixed `initialization_failed` fatal code and never ready. A ready message asserts Node family/version, not production provider connectivity. The client never synthesizes ready.

`request(command)` requires ready state. Correlation IDs include the worker generation and sequence. Responses may arrive out of order; unknown IDs, wrong result types, malformed data, repeated readiness or oversized messages terminate that generation and reject its pending requests. Request timeouts likewise terminate the generation: a timed-out mutation has **unknown outcome**, and the transport never retries or replays it. The caller must reconcile against durable operation state/provider results before issuing another mutation.

Unexpected child close rejects pending calls. While desired, the supervisor schedules exponential restart delays capped at the configured maximum, with a finite attempt budget across successful/failed automatic launches. A healthy ready event does not reset that budget; explicit `start()` from a stopped/failed process starts a new budget. Calls during startup/backoff fail with a fixed not-ready error, rather than queueing or replaying operations. Await stop before explicitly starting again.

`stop()` cancels backoff/preparation, rejects pending requests, sends a private shutdown message and closes stdin. The production worker stops accepting operations, closes its database and exits on shutdown, parent stdin EOF, SIGTERM/SIGINT or a broken pipe. It also bounds shutdown to two seconds while awaiting an opener or stdout drain. If it does not exit during the configured allowance, the supervisor sends SIGKILL; it then waits for child close before resolving. As with OS process supervision generally, process reaping depends on the operating system. Do not spawn descendants that inherit the transport's stdio; descendant-held pipes can prevent close. No replacement is launched after stop.

## Protocol and integration

Frames are UTF-8 JSON followed by newline, with a 64 KiB payload cap excluding newline. stdout belongs exclusively to the protocol. Parent buffering and admitted requests are bounded; the real worker must enforce the same byte cap **before** accumulating/parsing input. Use `parseParentMessage` and `parseWorkerMessage` for strict schemas and reject malformed frames. Worker stderr is drained and discarded, never copied to logs: provider failures and paths can contain credentials or mailbox content.

Production commands and results:

| Command | Result |
| --- | --- |
| `ping` | `{pong:true}` |
| `mail.storage.status` | `{encrypted:true,schemaVersion:number,syncSupported:true}` |
| `mail.accounts.list` | `{accounts:[{id,provider,displayName}],nextCursor:string|null}` |
| `mail.folders.list` with `accountId` | `{folders:[{id,name,kind,parentId}],nextCursor:string|null}` |
| `mail.status` with `accountId` | `{sync:MailSyncView}` after owner-scoped account verification |

Account/folder commands accept optional `limit` (1–100; default 50) and `after` (opaque ID). Repository keyset queries use SQL `LIMIT limit+1` with owner/account constraints; they do not load all rows and slice. The worker additionally caps complete encoded response frames at 64 KiB. A byte-limited page returns a cursor for its last returned row so the next request cannot skip omitted rows. If an individual row cannot fit, the worker returns `response_too_large`; it never truncates IDs or names. Concurrent mailbox changes follow ordinary keyset pagination semantics rather than a frozen snapshot. Foreign and absent accounts return the same `not_found`. Owner IDs and database column names are not returned in DTOs.

`mail.sync.start` takes an owned Gmail account ID and trusted desktop OAuth settings; `mail.sync.stop` takes the account ID. Both return the same strict, account-correlated `MailSyncView` as `mail.status`. The worker runs resumable Gmail backfill with eager encrypted original and MIME-part storage. Start returns immediately, pause revokes work, and reopening preserves progress for explicit resume. Gmail is the implemented provider; Graph/IMAP sync and direct `credentials.update` remain unsupported. Idle means no history run, not a synchronized mailbox. Results must match the command. There is no SQL, arbitrary filesystem/network request or shell command. Trusted database location is startup configuration, not a remotely callable file operation. Unsupported requests should return the fixed `unsupported` error. Extend protocol unions, validators and tests intentionally when the real worker handlers and mailbox model support additional operations.

This channel is private to a parent-created process and is not a server authentication boundary. The parent must authenticate/authorize public routes, validate account ownership and translate narrow domain operations; never expose the transport directly as a remote command proxy. The real worker must independently validate frames and account scope. Root integration owns build/packaging, desktop key supply, server auth/routes and application shutdown hooks. Build `worker.ts` to `dist/mail/runtime/worker.js`; native modules resolve relative to the built storage module via createRequire, so staging must preserve package resolution and unpack native artifacts. Future credential updates must acknowledge success only after securely applying/persisting updates; refresh persistence is handled internally by the account access coordinator and encrypted credential repository.

Diagnostics contain only constant event/error codes and restart counts. `status()` returns lifecycle state, restarts and pending count. Neither includes supplied IDs, paths, tokens, keys, raw child output or provider error bodies. Diagnostic callback exceptions cannot interrupt cleanup.

## Verification

From the repository root:

```sh
LEGALWORK_MAIL_TEST_NODE=/absolute/path/to/node pnpm --dir apps/server exec bun test src/mail/runtime/client.test.ts
```

Fixture tests otherwise resolve a concrete `node` executable from PATH; production has no implicit executable fallback. To also exercise a real Electron executable, set `LEGALWORK_MAIL_TEST_ELECTRON=/absolute/path/to/Electron` for the same command. That test is explicitly skipped when no Electron path is supplied.

Validated under Bun 1.3.9 with Node 24.11.0 and Electron 35.7.5/Node 22.16.0: handshake/coalesced start, out-of-order correlation, crash rejection, lost responses, malformed/oversized/wrong responses, startup and supplier hangs, capped restart, stop during backoff, explicit restart, forced hung-shutdown termination, pending admission, outbound cap, secret-free diagnostics and strict command rejection. These tests use actual child processes but fake worker handlers; they do not validate native encryption, database recovery, packaged distribution or mail synchronization.

### Actual encrypted entrypoint integration tests

Run the built-worker tests (plus transport and repository checks) with:

```sh
LEGALWORK_MAIL_TEST_NODE=/absolute/path/to/node LEGALWORK_MAIL_TEST_ELECTRON=/absolute/path/to/Electron pnpm --dir apps/server exec bun test src/mail/runtime/client.test.ts src/mail/runtime/worker.test.ts src/mail/storage/repository.test.ts
```

`worker.test.ts` compiles the actual TypeScript worker and its storage dependencies into a temporary directory with a module package marker and a temporary node_modules link to the server dependencies. It launches the resulting JavaScript under a real Node/Electron child, without Bun native loading, TS loader hooks or NODE_PATH. Synthetic seed data is created by an isolated Node setup process with its key delivered on stdin. Tests cover encrypted migration/readiness, own/foreign account and folder pagination, encoded-size caps without skipped rows, malformed/noncanonical/wrong key rejection without modifying existing data, unsupported provider operations, EOF/signals, protocol input failures and successful reopening. The same encrypted database is read under actual Electron Node mode. This verifies local addon compatibility, not packaged application signing/fuses or other operating systems.
