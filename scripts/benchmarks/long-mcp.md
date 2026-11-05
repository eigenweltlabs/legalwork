# Complete MCP result scenario

This is a synthetic, read-only legal archive delivered by an authenticated MCP
server. It checks full result retrieval, amendment chronology, a future effective
date, precise source attribution and a complete-source digest. It is prepared for
the real Electron/engine benchmark; preparation and transport checks make no
model calls and establish no live-agent quality result.

Prepare once **on the controller**, outside every agent guest:

```sh
node scripts/benchmarks/prepare-long-mcp.mjs --output /private/controller/long-mcp
node scripts/benchmarks/long-mcp-server.mjs --fixture /private/controller/long-mcp --traces /private/controller/v1-mcp-traces
```

The fixed endpoint is `http://127.0.0.1:39182/mcp`. Forward only that endpoint to
the same guest loopback port. The benchmark controller applies the throwaway
credential and connector definitions from private `transport.json`; its `v1`
and `v2` entries express the same server using the respective native schemas.
Never print the token or copy the transport file into the task workspace.
Keep source, suite, provenance, expectations, generator/server code and traces on
the controller. The guest receives only the connector configuration and actual
task prompt. The suite declares no copied source files.

Use the same frozen `suite.json` and source bytes for both fresh isolated arms.
The MCP response preserves the complete JSON twice according to the protocol:
original text in `content` and the identical object in `structuredContent`.
Neither contains a rubric or expected-answer object. The schema describes the
source data truthfully. Per-request controller traces retain exact request and
response bytes plus delivery/completion hashes; authorization headers are never
written to these traces.

The agent must save `mcp-notice-review.json` with correct current and superseded
terms, distinguish the future-effective amendment, provide the exact operative
sentence and final source receipt, count the complete records array, and compute
the digest of the complete compact JSON source. File existence alone cannot pass.
The independent `capability.mcp_tool` assertion additionally requires a completed
exact MCP call: either the direct V1/native identity or an authoritative completed
Code Mode child entry with a completed parent tool result and real message/call
identities. Generic `execute` calls, substring name matches, running/error entries
and metadata without a result do not pass. Existing `capability.tool` assertions
are unchanged.

```sh
node --test scripts/benchmarks/long-mcp-evidence.test.mjs scripts/benchmarks/prepare-long-mcp.test.mjs
LEGALWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode node --test scripts/benchmarks/*.test.mjs
```

The frozen controller instance prepared on 2026-10-25 contains 2,024,587 source
bytes and 7,004 records; its controlling amendment and verification receipt are
beyond the first MiB. Its source SHA256 is
`ef67b0b02cb46260c65555bce12625872a0378a7aba3458db690ee99e6f786dd`.
The private fixture receipt records exact suite, source, code and harness hashes.

No request/result size cap, tool deadline or task deadline is introduced by this
fixture. Its finite synthetic dataset is a scenario input, not a product limit.
It does not cover OAuth, forms, media or live-account behavior. Actual model runs
must use the existing shared EUR100 guard and normal permission behavior; an
unexpected permission or form still stops an autonomous scenario. No real-model
run in either arm is claimed by these harness tests.
