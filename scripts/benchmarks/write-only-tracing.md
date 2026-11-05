# Private write-only tool tracing

This is opt-in benchmark instrumentation. It is not a production plugin, a tool,
or an agent-readable artifact store. Historical runs that used readable JSONL
journals retain their original evidence and context/performance qualification.

`write-only-recorder.py` runs as root on Linux. It uses the public
[`SO_PEERCRED` Unix-socket interface](https://man7.org/linux/man-pages/man7/unix.7.html)
to require the actual engine PID, UID and GID. The configured process start time,
root-owned executable path, inode identity and initial SHA256 are also checked.
A same-UID shell/tool child is not the bound engine. Restarting the engine
requires a new explicit binding and a new recorder directory.

Contract4 adds a pre-admission registration. Start the root sink after binding
the actual engine, then install the observer through normal configuration. Its
metadata-only `observer.ready` payload has sequence0 and no tool/input/result.
The sink durably stores a private registration and empty journal, then ACKs its
hash. The producer must show `ready:true`, no pending writes/errors and the same
registration hash. This proves an empty journal is activated transport, rather
than treating no events as evidence that observation works. Tool records start
at sequence1 with a null previous hash. Failed registration is sticky and cannot
be accepted as preflight readiness.

The root-owned socket directory is not writable by the agent. Its socket accepts
only an `append` envelope and returns only sequence/hash acknowledgments. It has
no read/list endpoint. Full arguments, results and exposed errors are appended
to root-private `0600` journals under a `0700` directory. Journal file, health
file and containing-directory metadata are synced before acknowledgment.

`write-only-tool-journal.mjs` snapshots each hook value before returning, then
queues transport asynchronously. It writes only counters, hashes and health
metadata to the agent profile. A slow or unavailable recorder does not replace
a tool output/error, change permissions, or insert recovery hints into context.
An unknown/lost acknowledgment is sticky incomplete evidence; events are not
automatically retried. There is no tool/output/event-size cap or transport task
deadline. An unresponsive sink can leave pending writes and consume memory;
such a run cannot pass complete-capture checks. Serialization/enqueue CPU and
background append/sync work remain instrumentation overhead, never subtracted
as hypothetical latency.

Each observer gets a separate UUID and metadata file. Native IDs are unchanged.
Repeated concurrent calls sharing a parent ID/tool/input retain every result;
individual pairing duration stays unknown. Before-only V1 errors/cancellation
remain before-only. Complete API-reported terminal failures may be classified
under the separate pinned-source lifecycle-as-exposed contract; no raw AFTER,
return value, stack, stage or duration is manufactured.

Capture verification requires all of the following, rather than trusting a
producer's writable health file alone:

- root journal sequence/hash-chain and root recorder health;
- producer sequence/acknowledged hash equality and no pending writes/IO errors;
- exact requested-session attribution and complete owned subtree/API lifecycle;
- full successful AFTER results, with source-backed failure availability explicit;
- a root-reviewed executable/observer/config identity and private storage proof.

The packaged harness reads only its configured root journal/registration/health
paths using the existing privileged SSH controller. It validates root ownership,
private modes, canonical paths, deployed observer/recorder hashes, actual live
PID/start time, registration payload hash and producer/root sequence equality.
Full returned bytes and their hashes are retained privately on the controller.
This is a fixed benchmark relay; no app-facing read endpoint, arbitrary caller
path, model tool or production credential is introduced. Historical contract3
proof remains frozen under its original source identities; the clean normal
trial uses a separately frozen contract4 harness.

The local tests exercise complete >1MiB values, delayed/lost acknowledgments,
domain failures, same-parent concurrency, pending before-only calls and health
disagreement. An actual Linux real-engine transport proof is separately frozen
on the controller. Synthetic transport tests do not establish legal quality,
normal Electron behavior, cost improvement or matched performance.
