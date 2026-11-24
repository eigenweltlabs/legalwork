# Sonnet end-to-end verification — 21 November 2026

## Scope

Executed real requests through the installed native engine and the existing **Eigenwelt Europe Claude Sonnet** connection. No model responses were mocked. Production event capture, reconstruction, validation and record-admission routes ran against a separate local database. The actual TimeRecordSheet and Day timeline components used that server through the ordinary client. A temporary development entry point supplied the isolated connection; it was removed after verification.

All project, task, calendar, document, matter, client and guideline content was synthetic. No test billing records were sent to the firm's synchronization service. This verifies the local generation-to-acceptance path used by the records UI, **not** hosted authorization, synchronization delivery or centralized invoicing.

## Input and observed results

One project was linked to one synthetic matter and billing client. The input combined a calendar work interval, a completed task without a due date, a document save, and overlapping foreground, passive-window and agent observations. The file was deliberately named `Rekurs-PR438.md`.

Reviewed matter guidelines required German wording, “Revision” instead of “Rekurs”, no filename or extension, descriptions limited to supported work, and “Entwerfen” for initial drafting. Numeric rules required upward rounding to six minutes, a six-minute minimum and a sixty-minute maximum. Sonnet extracted the numeric rules with supporting quotations; those proposed rules were explicitly saved before reconstruction. A separate applicable billing policy governed acceptance.

| Case | Source interval (Europe/Vienna) | Actual model output and accepted values |
| --- | --- | --- |
| Initial document creation | 21:36–21:53 | One DFT proposal, correct matter and stable document ID; **17 Recorded / 18 Billable**. “Entwerfen der Revision; Ausführungen zur Zulässigkeit der Revision und zum geltend gemachten Verfahrensmangel.” |
| Later save of the same document | 21:54–22:09 | One MOD proposal with the same document ID and matter; **15 Recorded / 18 Billable**. “Überarbeiten der Revision; Präzisieren des Abschnitts zu den Rechtsfolgen.” |

The first reconstruction combined corroborating sources into one entry. Passive-window and agent runtime did not add human minutes. Both descriptions retained the required terminology and the evidenced subjects; neither used the filename. The second save included a new completed task and calendar interval describing the amendment.

Inspection of the actual MOD request confirmed the matter's guidelines and document identity, but **not the first accepted narrative as document history**. In this records flow, accepting unchanged AI wording creates neither a human correction example nor a workflow work-product binding. Confirmed document history is supplied from eligible workflow entries linked to a work product; the ordinary-records path does not provide that full history. Explicit human wording edits have a separate private learning path covered by regression tests, but this live run did not exercise it. The observed use of “Revision” therefore demonstrates guideline compliance, not learning from an earlier human correction. No local substitute for authoritative workflow history was introduced.

Both proposals were accepted through the UI. The saved records retained the chosen matter/client, original clock ranges, actual durations, rounded billable durations and reviewed model narratives. After reload and reconstruction, two records remained, totaling **32 Recorded / 36 Billable**, with **zero remaining suggestions** from those consumed sources.

For a negative test, a ten-minute billing policy rejected an 18-minute proposal without saving another record. Restoring the six-minute policy allowed **Try again** to complete acceptance. No policy validation was bypassed. The isolated policy changes do not alter the connected firm's rules.

DFT/MOD and document identity were verified in the private proposals and their provenance. Ordinary synchronized time records still use the fields exposed by the firm; this test does not establish hosted support for additional activity-code or document-identity fields.

## Corrections made after real failures

- Numeric-rule extraction now requests the complete JSON schema. Sonnet had returned `notes` as a string instead of an array.
- Grouping and wording use the same schema contract. An otherwise usable response with prose after its JSON had failed the entire reconstruction. A maximum of one format-repair request is allowed per response within the existing deadline. Provider and cancellation failures are not retried as format errors; unsupported guideline evidence remains rejected.
- Grouping explicitly permits task, save and interval observations to corroborate the same work. A source's initial activity hint does not force a separate entry.
- Reconstruction preserves the model's guideline-aware narrative. It previously replaced DFT/MOD wording with a fixed verb and filename whenever the save lacked a change summary, even when the grouped task and calendar supplied the subject. Explicit document terminology corrections still apply. The wording request instructs the model to avoid specific changes when the evidence only establishes a file save. Narrative accuracy still requires human review; the validator does not prove the truth of free-form text.
- **Try again** retains an explicit failed acceptance. Previously it retried only the private save and left the acceptance error visible. A retry after a private edit stays private; changed drafts must be accepted again. Existing digest, overlap, revision and billing checks still run.
- The reconstruction cache version changed so an older generated result does not survive these corrections.

## Reproduce

Use a disposable local profile and a connected Sonnet model; keep the firm's live ledger out of the fixture. Link a synthetic project to a synthetic matter/client. In Timeline settings enable calendar, completed tasks, documents and workspace activity, select Sonnet, and save the reviewed guidelines described above. Configure the matching six-minute billing policy independently.

Create a 17-minute calendar event for drafting the Revision, create and complete a matching task without a due date, and save the synthetic document for the first time. Include overlapping passive/agent observations when testing the capture API. Open the selected day, review the resulting single DFT block and accept it. Reload and check the persisted row and consumed sources. Save the same file again with a corroborating amendment task and a separate 15-minute event; verify MOD, stable identity and wording, then accept. For the validation-negative case, change the isolated billing policy to ten minutes before acceptance, confirm no record is created, restore six minutes and retry.

Focused automated checks (from the respective package directories; native-engine tests require `LEGALWORK_TEST_OPENCODE_BIN`):

```sh
# apps/server
bun test --preload ./test-preload.ts src/time-capture

# apps/app
bun test tests/time-record-sheet.test.ts

# repository root
pnpm --filter legalwork-server typecheck
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @legalwork/app build
pnpm docs:generate
pnpm docs:check
```

The server suite covers output repair limits, provider/cancellation behavior, evidence validation, scoped wording, preservation of narratives, claims, document history, private corrections and acceptance. The UI fixture additionally covers failed acceptance followed by retry, and verifies that retrying a failed private edit makes no shared record write.
