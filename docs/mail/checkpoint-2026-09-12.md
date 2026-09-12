# Mail integration checkpoint — 12 September 2026

Branch: `feat/local-mail-client`. Draft [PR #130](https://github.com/eigenweltlabs/legalwork/pull/130). No merge, release or deployment is authorized by this checkpoint.

The user froze work to the nine tickets that were already In Progress. Complete their existing implementation and acceptance work where inputs permit, then stop. Do not start backlog tickets or broaden the scope.

## Accepted product changes

EIG-139 is Done. Explicit message opens enqueue durable read actions; Gmail/Graph account-scoped conversations have chronological cards and bounded earlier-message pagination. Pending read intent participates in authoritative thread totals. Reader content survives ordinary polling and transient validation failures. Initial HTML sizing uses a synchronous authenticated handshake, and request ownership survives StrictMode cleanup. The [reader evidence](reader-conversations-2026-09-12.md) retains the phased passing checks and the earlier failed attempts; it does not claim one uninterrupted green run.

EIG-172 is Done. Mail remains inside the shared app shell with dense rows, compact icon actions, inline search and hidden-by-default selection checkboxes. Mail Accounts uses shared Settings layout and controls. Routine synchronization does not open an Activity panel. Root reviewed synthetic screenshots, shared-control behavior and attachment-to-chat source return without a model request. See [design evidence](design-rework.md).

The combined server build passed. Root independently ran the native conversation/order and preview suites: 3/3 passed, covering account isolation, pending read counts, pagination/ties/tombstones, and preview freshness. These feature checks do not substitute for the final desktop qualification.

## Remaining original acceptance gates

| Ticket | Completed work and exact remaining requirement |
| --- | --- |
| EIG-152 | Final integrated macOS arm64/x64 and Windows x64 qualification runs remotely. Source-stamped stage outcomes and subsequent narrow repairs belong in [desktop qualification](desktop-platform-qualification.md). Full acceptance also needs actual signed install/update identity continuity and controlled device lifecycle checks. Unsigned directory builds are not that evidence. |
| EIG-126 | Local encrypted-store/token/key custody audit is reviewed. Actual platform evidence is tracked with EIG-152; signed identity continuity remains an external release gate. [Custody acceptance](key-custody-acceptance.md). |
| EIG-141 | Retained-corpus search/publication fixes and the bounded conversation-query optimization are integrated. Original reference-machine, Windows, OS-cold and full-app responsiveness evidence remains unfulfilled; M3 Max/36 GiB results are not a 16 GiB reference qualification. No second full ingestion is needed. [Benchmark record](large-mailbox-benchmark.md). |
| EIG-173 | Workspace read-only comparison passed: 609 identities, 14 labels, all memberships and sampled 10 originals/10 bodies/17 attachments. Do not repeat it. Other real accounts and controlled mutation/alias/Sent scenarios require the precise external inputs in [live-provider qualification](live-provider-qualification.md). |
| EIG-153 | The recorded synthetic provider/failure matrix is accepted at its stated source. Original real cross-provider and authorized outbound gates remain open through EIG-173. [Certification record](provider-failure-certification.md). |
| EIG-135 | Connection/reconnect and Settings implementation is complete. iCloud/Yahoo/Fastmail/two named generic-host live conformance needs authorized account inputs. IMAP access does not imply SMTP or alias permission. [Standards-provider matrix](standards-provider-matrix.md). |
| EIG-120 | Dedicated registrations, scope/PKCE/refresh ownership and actual local/optional remote data flows are documented. Personal Outlook verification, enterprise tenant/admin scenarios and provider/privacy/release approval inputs remain external. [OAuth reconciliation](oauth-approval-reconciliation.md). |

These seven tickets remain open; unchanged acceptance criteria have not been removed to manufacture completion. Linear has no Blocked state, so their descriptions distinguish completed implementation from missing external acceptance inputs. Credentials must be entered through local Settings/provider flows, never committed or pasted into issue evidence. No automated live send, delete, move, read-state mutation, external storage upload or model call was performed for this checkpoint.

## Local app and resource limit

All temporary design/reader Electron previews, API/Vite servers and their helpers were stopped. The lead then launched only the normal dev app with the existing `com.eigenweltlabs.legalwork.dev` profile. The previously used workspace session and its transcript were visibly restored; the session database was not reset or replaced. Synthetic evidence contains no private session or mailbox content.

**One local Electron application instance is permitted across the entire team.** Its renderer/GPU/network/mail-worker child processes belong to that one application. Agents must reuse the lead-allocated instance and must not launch previews alongside the normal app. `AGENTS.md` records this rule and requires feature-specific ticket checks, with broad app/platform testing only at final integration. Remote qualification excludes Linux.

## Remote evidence boundary

The final integrated matrix is [run 34705758095](https://github.com/eigenweltlabs/legalwork/actions/runs/34705758095), marker `9a6f3482007bad1ff24850d8311f2556d2f39353`, tree-identical to product source `ad06fba7b01966bdc00e432341fdcb21b48ea668`. Subsequent integration commits at the initial checkpoint contain documentation and no-launch diagnostic scripts, not new product behavior. Preserve failed stage results and identify any later targeted rerun source separately. A narrow rerun does not retroactively make the original full command green.

Attachment saves still depend on the shared connected-storage work in separate PRs; all connected writable roots are supported through that interface. The separate LegalMemory backend is optional matter filing and remains unmerged/undeployed. This checkpoint does not merge or certify those external changes.
