# LegalWork for Raycast

An optional entry point into the same LegalWork Assistant: the panel, files, actions and conversations are the app's own. The extension never needs Raycast AI.

## Pairing

1. In LegalWork open Settings, Assistant launcher, and enable Raycast pairing.
2. LegalWork writes `launcher-pairing.json` into its application-support folder with the local server URL and a per-session token. Only your user account can read it; the token changes on every app start and the file is removed when pairing is disabled.
3. From Raycast, run **Search LegalWork** to check the connection. The extension discovers the installed app’s profile automatically. When only the development profile is paired, commands open that instance.
4. The commands read that file on every call. Launch URLs (`legalwork://assistant/...`) carry identifiers only; selected text travels over the paired loopback connection as a one-time staged context that expires after five minutes.

## Commands

- **Open LegalWork Assistant**: resume the current conversation, or pass a question.
- **Ask LegalWork with Selection**: stages the front app's selection and opens the Assistant with it attached.
- **Search LegalWork**: files, projects, chats, tasks and recordings with per-source coverage. Open the exact result in LegalWork. For local project, Wiki and search-folder files, **Open** uses the default app; **Show in Finder** locates the source and **Copy File** puts the actual file on the clipboard. For files, tasks and recordings, **Chat with Assistant** attaches the item to your general Assistant's current draft; **Ask About This** starts a fresh project chat with the item attached and waits for your question. **Summarize**, available for files, starts a fresh project chat and sends the summary request. Wiki and search-folder items ask you to choose a project when there is no current project. Files from added folders are copied only after you choose the destination. Project chats can use your own AI provider; Chat with Assistant uses the Assistant plan.
- **Run LegalWork Quick Action**: saved quick actions on the selection or clipboard.
- **LegalWork Work**: delegated work and what needs your decision. **Open in LegalWork** opens the selected job's chat; **Open Origin Conversation** returns to the conversation that delegated it.

Use **Refresh Search**, **Refresh Work** or **Refresh Actions** after changing a source or restarting LegalWork. Unavailable sources and failed requests are shown explicitly.

The Raycast extension uses the published Raycast List API, which does not expose a custom native drag-out handler. Use **Copy File** and paste into Finder or another app, or drag the result from LegalWork's own Assistant mini-bar. The extension does not provide multi-selection or incoming file drops.

A cold start is an ordinary launch URL; LegalWork queues the invocation and delivers it to the panel once it is ready. Repeated delivery of the same invocation does nothing twice.

## Development

```bash
pnpm --dir apps/raycast-legalwork install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm --dir apps/raycast-legalwork dev
```

Run `node apps/raycast-legalwork/node_modules/typescript/bin/tsc --noEmit -p apps/raycast-legalwork/tsconfig.json` for its type check. Build from the extension directory with `./node_modules/.bin/ray build -e dist`. The extension is installed independently because it is excluded from the application workspace; its lockfile and shared `@legalwork/types` dependency are committed.

The extension uses Raycast's selection and launch APIs. Type checking and building do not verify platform behaviour; cold start and selection still need a real Raycast run.
