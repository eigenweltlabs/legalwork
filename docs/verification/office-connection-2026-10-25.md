# Office connection verification — 25 October 2026

## Automatic connection

The PR branch was built and run in real Electron 43.7.5 on macOS, with an isolated desktop profile and the Office HTTPS listener on localhost. The updated flow has no code screen or desktop approval dialog. Installation supplies a separate Office credential through a private local manifest.

A native integration probe used Node HTTPS with the local CA explicitly trusted; certificate verification stayed enabled. It verified:

- Public bootstrap contains no application, host, or installation credential.
- Anonymous session creation returns 401.
- The installed Office credential creates a session automatically, and that session can call `/whoami`.
- The Office credential cannot access host-only environment settings.
- After stopping and restarting the isolated Electron app, the previous Office credential still works and the automatic exchange returns the same credential.

The regression tests also cover cross-origin and rebinding requests, credential rotation, concurrent first starts, private file permissions, automatic migration from the previous app credential, and removal of the retired pairing endpoints. An API integration test runs with manual approvals configured to deny and confirms the connection invokes no approval callback. The shell test executes its JavaScript to verify that it captures and removes the fragment before handing off to the app.

Commands:

```sh
pnpm --filter legalwork-server exec bun test src/office-connection.test.ts src/word-addin-shell.test.ts src/word-addin.e2e.test.ts src/tokens.test.ts
node --test apps/desktop/electron/office-addin-platform.test.mjs apps/desktop/electron/office-addin-cert-web.test.mjs apps/desktop/electron/runtime.test.mjs apps/desktop/electron/host-approvals.test.mjs
pnpm --filter legalwork-server build
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app build:word-addin
```

## Word UI and document tools

The updated pane was successfully exercised in Microsoft Word 16.114.1 against the PR checkout's Electron 43.7.5 app. The test used an isolated desktop profile, a private test manifest, and a synthetic document named `Seamless Word Connection Test.docx`.

1. Opened the document in real Word and loaded the installed add-in. It advanced to the workspace list and displayed **Ready** without a code or desktop approval dialog.
2. Opened the test workspace and created a conversation from the Word pane.
3. Called the authenticated Office tool relay. The real Word pane executed `word_read_document`, `word_replace_text`, `word_add_comment`, and `word_search` through Office.js. The replacement changed the payment period from **60 to 75 days** and reported `trackedChange: true`; search found the new sentence once.
4. Saved the document in Word. The title displayed **Saved to my Mac**. Reading the saved DOCX confirmed that the replacement text and the new comment were present.
5. Closed all test add-in panes, stopped the isolated Electron process, and launched the same PR checkout again.
6. Reopened the installed add-in from Word's **Open LegalWork** button. It displayed the workspace/session list and **Ready** without a code or approval dialog.
7. Resumed the conversation and repeated document read and search successfully through the real Word pane. The earlier Office credential also remained valid after the Electron restart.

[Sanitized native test results](office-automatic-connection-results.json) record the checked revision, versions, and outcomes. Word UI screenshots were captured during the run in the accompanying chat.

The isolated profile had no model provider connected. This run tested the actual Word webview, automatic authentication, Electron restart, and live Office.js document operations directly through LegalWork's relay; it did not make a new model inference request. The earlier production model run below covers that separate path.

To reproduce manually:

1. Build and start this PR's desktop app.
2. Enable the Word add-in in LegalWork, then open it from Word's Add-ins menu. An already enabled installation refreshes its manifest automatically; restart Word if it caches the previous manifest.
3. Confirm the pane connects without a code or an approval dialog, and exercise document read/edit/comment/search tools on a synthetic document.
4. Save the document, close the pane, restart LegalWork, and reopen the pane. Confirm it reconnects without prompting and document tools still work.

## Earlier production model regression check

Before the automatic connection revision, a Word tool run completed in real Microsoft Word 16.114.1 and Electron 43.7.5, connected to `https://platform.eigenweltlabs.com`. In a synthetic document, the production model read text, changed the payment period from 45 to 60 days as a tracked change, added a comment, and searched for the resulting text. Saving and reading the document again verified that the edit and comment persisted.

All four tools completed: `word_read_document`, `word_replace_text`, `word_add_comment`, and `word_search`. Claude Opus 5.5 EU completed the run after the initial Gemini request encountered a provider capacity response.

This screenshot is evidence of that earlier document-tool run, not of the new automatic connection handoff.

![Synthetic Word document after the earlier production model edit and comment](office-production-word.png)
