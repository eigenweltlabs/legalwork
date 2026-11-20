# LegalWork for Raycast

An optional entry point into the same LegalWork Assistant: the panel, files, actions and conversations are the app's own. The extension never needs Raycast AI.

## Pairing

1. In LegalWork open **Settings > Assistant launcher > Raycast** and select **Enable pairing**.
2. LegalWork writes `launcher-pairing.json` into its application-support folder with the local server URL and a credential scoped to Raycast commands. The credential rotates when the local server restarts. **Disable pairing** revokes it immediately and removes the file.
3. From Raycast, run **Search LegalWork** to check the connection. The extension discovers the installed app’s profile automatically. When only the development profile is paired, commands open that instance.
4. Questions, selections, actions and result references travel over the authenticated local connection. The launch URL carries only a single-use handoff ID that expires after one minute.

## Commands

- **Open LegalWork Assistant**: resume the current conversation, or pass a question.
- **Ask LegalWork with Selection**: stages the front app's selection and opens the Assistant with it attached.
- **Search LegalWork** finds files, projects, chats, tasks and recording titles in sources available to the paired extension. Recording transcripts open in LegalWork. For local files, **Open** uses the default app, **Show in Finder** locates the source and **Copy File** puts the file on the clipboard. **Chat with Assistant** attaches the item to the current general Assistant draft. **Ask About This** opens a fresh project chat with the item attached and waits for your question. **Summarize**, available for files, sends a summary request in a fresh project chat. Wiki and search-folder items ask you to choose a project when there is no current project. Files from added folders are copied after you choose a destination. Project chats can use your own AI provider. **Chat with Assistant** uses the Assistant plan.
- **Run LegalWork Quick Action** uses the exact selection or clipboard text, including whitespace. Select or copy a shorter passage if the input exceeds 200,000 characters.
- **LegalWork Work**: delegated work and what needs your decision. **Open in LegalWork** opens the selected job's chat; **Open Origin Conversation** returns to the conversation that delegated it. A green **✓ Done** marks a final reply. **Idle** indicates that the job has no active turn or confirmed result.

Use **Refresh Search**, **Refresh Work** or **Refresh Actions** after changing a source, switching profiles or restarting LegalWork. If the pairing changes while a list is open, refresh the list before using its results.

The Raycast extension uses the published Raycast List API, which does not expose a custom native drag-out handler. Use **Copy File** and paste into Finder or another app, or drag the result from LegalWork's own Assistant mini-bar. The extension does not provide multi-selection or incoming file drops.

LegalWork consumes each paired command once and delivers it when the panel is ready. If the local server has stopped or a handoff has expired, open LegalWork and run the command again.

## Development

```bash
pnpm --dir apps/raycast-legalwork install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm --dir apps/raycast-legalwork dev
```

Run `node apps/raycast-legalwork/node_modules/typescript/bin/tsc --noEmit -p apps/raycast-legalwork/tsconfig.json` for its type check. Build from the extension directory with `./node_modules/.bin/ray build -e dist`. The extension is installed independently because it is excluded from the application workspace; its lockfile and shared `@legalwork/types` dependency are committed.

The extension uses Raycast's selection and launch APIs. Type checking and building do not verify platform behaviour; cold start and selection still need a real Raycast run.
