# Support failure fixes and verification

Only sanitized excerpts and newly generated synthetic fixtures were used. No original customer diagnostics or chat messages were opened. The original user report came from LegalWork 0.2.19. Reproductions used application baseline `15b52ba2` and OpenCode 1.18.29.

## 1. Image requests rejected before inference

Six unchanged PNGs produced a 17,804,589-byte JSON request; nine produced 26,706,779 bytes. Both exceeded the gateway's own 16 MiB nginx limit and returned HTTP 413. One image succeeded. With the local production nginx image allowing 30 MiB, the same six and nine images reached the configured EU Sol upstream and all center colors were identified correctly.

The pinned engine treats HTTP 413 as token overflow and tries compaction. LegalWork now preserves transport-size failures as ordinary errors before that classification, including content-free request-byte measurements and an advertised byte limit when present. Explicit provider `context_length_exceeded` responses retain their existing compaction behavior. The UI tells the user to revert before the attachments or use fewer attachments in a new chat.

Original image bytes, dimensions and detail are unchanged. A `.jpg` filename does not prove JPEG content; the existing reader already sniffs media bytes. No image resizing, re-encoding or attachment removal was added.

The companion [model-api PR #133](https://github.com/eigenweltlabs/model-api/pull/133) raises nginx's configurable default to 100 MiB; `MAX_REQUEST_BYTES=0` explicitly disables that nginx guard. The shared Cloud Run HTTP/1 service still has its own 32 MiB ceiling. Its ingress stays unchanged because the service also carries transcription WebSockets. Supporting requests above that platform ceiling requires separate inference ingress or provider-supported image references. Nothing was deployed.

[Image-byte verification](../reviews/support-failures/electron/image-hash-verification.json) · [original rejection](../reviews/support-failures/electron/images-413.png) · [successful retry](../reviews/support-failures/electron/images-success.png)

## 2. Invalid tool calls and recovery

Saved-output tools now separate reading a page from searching literal text. The model supplies a path and continuation offset; page size is managed by the tool. Historical empty queries still read a page, and excessive historical page sizes are capped. Search preserves both existing read permissions and its own search permission.

A separate always-loaded recovery plugin handles confirmed argument-validation failures across native, LegalWork and MCP tools, including Word. It observes runtime tool definitions and verifies runtime validation issues against actual input values when the engine's advertised JSON Schema omits constraints. MCP Invalid params and explicit argument-validation results receive correction guidance; permission denials, timeouts, service failures and response-validation errors do not count.

The assistant receives field-level correction guidance immediately. After three identical failures it receives a stronger warning. After two additional assistant steps repeat the same invalid call, it receives a final warning that another identical validation failure will forcibly stop the run. The next repeated failure stops it. Parallel calls in one assistant step count as one recovery attempt; duplicate events do not count. Corrected arguments, a successful tool call or a new user turn reset recovery.

Guidance is appended to the failed tool result in the next model request. The system prompt stays fixed. Automatic stops persist a structured reason anchored to the failed assistant turn. The chat explains the automatic stop and offers a follow-up; this survives reload. Manual Stop retains **Stopped**. Older saved stop notes also gain an explanation.

Real Sol in the full Electron dev app made exactly five identical invalid Word reads, quoted the final warning, and finished without a sixth call. A second test deliberately continued through the sixth failure and was automatically stopped with the explanation visible live. A separate run was stopped with the native Stop button. Reloading preserved the distinct outcomes. The DOCX hash was unchanged.

[Final warning and stop verification](../reviews/support-failures/electron/final-warning-and-stop-verification.json) · [fifth-call warning](../reviews/support-failures/electron/final-warning-five.png) · [live stop explanation](../reviews/support-failures/electron/automatic-stop-explanation-live.png)

## 3. Repeated Word serialization and queued work

The save path previously re-imported the exported DOCX to repair negative formatting. That inflated all media and rebuilt previews on every save/checkpoint. Formatting repair now patches `word/document.xml` while preserving the rest of the package. Saves and recovery checkpoints share one export in flight and reuse the export for an unchanged revision.

In full Electron, six tracked edits on the same synthetic media-heavy document took 47.3 seconds before and 14.4 seconds after. These timings cover all six edits and saves, rather than opening the document or making one edit. The remaining time includes the SDK's necessary serialization of the media-bearing package. Original media bytes, comments and revision anchors were checked after saving and reopening. A shell fallback completed its handoff in about 2.7 seconds.

This reproduces the expensive import and queue mechanisms seen in the sanitized excerpts. It does not prove that every part of the reported 49-minute incident had the same cause.

[Electron timing comparison](../reviews/support-failures/electron/word-electron-comparison.json) · [package preservation](../reviews/support-failures/electron/word-package-verification.json) · [baseline](../reviews/support-failures/electron/word-baseline.png) · [fixed editor](../reviews/support-failures/electron/word-live.png) · [shell handoff](../reviews/support-failures/electron/word-shell-success.png)

## 4. Stop, deadlines and Quit

Abort signals, request identities and absolute deadlines now reach the renderer's document queue. Cancelled or expired requests check before mutating a document. Already applied edits finish persistence; cancelling a caller never lets the next writer overtake that cleanup. Native file edits and shell handoffs participate in cancellation. Shell preparation is bounded to 30 seconds and release to 5 seconds. Reads skip handoff, and a project with no open editor needs no import. A bridge timeout no longer claims that the document is closed.

Quit cancels pending loopback bridge connections. A 10-second watchdog terminates owned workers if graceful shutdown stalls. Managed children are checked for actual process exit rather than assuming a sent signal proves termination.

Full Electron checks cancelled waiting document edits while preserving the applied prefix, rejected expired work before it reached the renderer, and quit a frozen-renderer scenario in 1.17 seconds.

[Stop observation](../reviews/support-failures/electron/stop-observation.json) · [Stop in Electron](../reviews/support-failures/electron/stop-word.png) · [deadline result](../reviews/support-failures/electron/deadline-electron.json) · [Quit result](../reviews/support-failures/electron/quit-electron.json)

## Validation and limits

The final PR checks run focused app tests, the server plugin/runtime/handoff suite, pinned-engine integrations, desktop lifecycle/bridge tests, typechecks, the server build, packaged-plugin checks, bundled help generation/check and English/German translation checks. Exact commands and final results are listed in the pull request.

The earlier full app-suite comparison encountered three Lexical module initialization errors also present on the unchanged baseline. The focused changed-area suites pass. Sandbox VM tests were skipped as requested. Native Electron verification was on macOS; Windows still requires a Windows runner. No app release or gateway deployment was published.

## Reproducing the engine checks

After `pnpm install --frozen-lockfile`, run:

```sh
pnpm --dir apps/server build
LEGALWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode pnpm --dir apps/server exec bun test src/opencode-plugins/support-reproductions.integration.test.ts src/opencode-plugins/legalwork-tool-output.integration.test.ts
```

These tests use isolated projects, a local synthetic model/MCP fixture and the supplied OpenCode binary. They cover native, saved-output, MCP and production Word validation failures and recovery, transport 413 classification, and saved-output access through a native explore child. They use no live model credentials or customer files.

For the Electron retry checks, open an isolated dev profile and a synthetic Word file. Ask the agent for five identical invalid `inapp_docx_read_document` calls, one per assistant step, with `view="invalid-test-view"`, then ask it to quote the final warning. In a new turn, request six calls and deliberately continue after that warning. Verify the automatic stop explanation, then stop a separate harmless running task manually and reload the chat. The evidence above records this exact flow with real Sol.
