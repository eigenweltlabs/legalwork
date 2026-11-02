# Workspaces and chats

Open in LegalWork: [Home](legalwork://app/home), [Projects](legalwork://app/projects).

## Folders and workspaces

A workspace ties conversations and agent execution to a working directory or remote worker. Select the working context through **Projects** or the project sidebar. Create a project using a local folder, or use the connection flow for a remote worker. Selecting another workspace changes the files and runtime context used for new work.

Workspace settings include authorized folders. Global settings include model providers and the shared skill library. A remote worker may have different files, credentials, models and permissions from your local computer. Check the selected workspace before diagnosing missing files or tools.

**Projects** and **Project Home** provide matter details, linked folders and separate pages for files, chats, tasks, calendar, reviews and dashboards. See [Projects and sharing](projects-sharing.md). Sharing a project through the firm is different from the remote-worker connection described below.

Project menus provide the actions available in this context, including renaming and opening another window. Choose **Remove project** and confirm to take a project out of the sidebar. Its saved chats and files on disk remain preserved. A workspace export is not a backup of every cloud account, secret or remote source.

## Conversations

In a project, **New Chat** starts a conversation in that project. From the Personal Assistant, it opens a project picker so you can choose where the new conversation belongs. The Assistant conversation stays available. **Cmd/Ctrl+N** follows the same behavior.

The composer accepts a task, file attachments, `@` references and available slash commands. The model selector applies to the conversation. The assistant may ask a question or request permission while working; answer in the supplied controls. You can stop an active response and send a follow-up. Queued messages wait for the running work to reach the next opportunity to handle them. Stopping also cancels document requests that are still waiting to run. An edit already applied may finish saving; Stop does not undo that edit.

A background refresh keeps the current chat ready for typing, Run and Dictate. Opening a different chat still waits for that chat to load.

In an idle project, wiki or Assistant chat, a normal message appears immediately while LegalWork confirms delivery. Confirmation updates that same message. If sending fails, the local message is removed and your draft remains available to retry. Messages for busy or paused chats remain in the editable queue until delivered.

### Steer with a queued message

While a chat is working, normal sends stay in the editable queue above the composer. To have a pending message considered sooner, choose **Steer** beside it. The agent receives it at the next model step, without stopping the current task or cancelling its tools. If the task has just finished, the message becomes the next input instead.

Steer keeps the active chat's model and agent, even if you selected different ones when saving that queued message. Its attachments, references and context are included. Other queued messages keep their order. You can Steer one message while the queue is paused; the rest remain paused.

Once accepted, your message appears in the conversation immediately, even while a tool is still finishing. The agent incorporates it at the next model step.

Steer is available for ordinary prompts, including prompts with attachments. Shell and slash commands cannot be steered. Finish or cancel editing before steering. Messages reserved for editing in another window, sending, or awaiting delivery confirmation cannot be steered again. If delivery is uncertain, LegalWork keeps the message and checks the engine automatically. Do not send another copy. A definite failure displays its reason and leaves the draft available to edit or retry.

If a message is rejected, its draft stays available with the reason. An unconfirmed delivery can already have reached the engine; inspect the chat before resuming it. Assistant follow-ups pause after a definite rejection or three unsuccessful delivery checks. Resume them explicitly after resolving the cause.

Use a conversation's action menu to rename, pin, archive or delete it. Archiving preserves the conversation; deletion is a different action. Sidebar groups organize conversations, and moving a chat into a group does not move its underlying documents. Search can locate earlier chats by title or message text. Opening a previous chat is the way to resume its context; a new chat is not an assurance that the assistant remembers every prior conversation.

Tool activity shows the tools the assistant uses, with icons for actions such as reading, editing, searching and running commands. Expand an activity row to see its individual actions; one row can include several tools. When the assistant starts a subagent, its row shows progress and opens the child chat when selected. Results such as review cards, draft emails, calculations and dashboard previews appear directly in the conversation, including when you reopen it. Filed tasks and LegalMemory sources also appear with the assistant's answer.

The command palette searches available navigation/actions. File/document tabs keep artifacts beside chat, and the terminal runs commands on the computer running LegalWork. Click the X on a chat tab once to close its view. The conversation remains in Sessions and can be reopened from there. A tab being open does not establish that its unsaved edits are already on disk. When a tool asks for permission or the assistant presents a question, respond in that control; stopping the response does not undo completed file changes.

When asking what was said previously, name the chat or topic and let the assistant read the returned transcript. A chat transcript is a record of that discussion, not independent evidence about a matter. For current matter facts, use the connected source documents.

## Amounts and formulas in answers

Answers display mathematical formulas and monetary calculations with their formatting, including euro amounts. This also applies when you reopen an earlier chat. Plain prices and examples inside code blocks keep their original text. A formula may appear as text while the assistant is still writing it and becomes formatted when it is complete. Wide formulas scroll horizontally within the answer.

## Connected services

When a browser task needs a login that is not saved, the assistant can show a **Sign-in details needed** card inline in the conversation. Enter the credentials there and choose **Save and continue**, or choose **Cancel** to stop the login attempt. The password is saved directly to the device vault and is not sent as chat text or an agent form answer. See [browser passwords](settings-privacy.md#browser-passwords) for saving, reuse and management.

Reloading the LegalWork window keeps its browser pages and text you have entered open. Closing the app can still discard unsaved website changes; save those changes on the website before quitting.

Connect cloud storage and other services through **Settings > Integrations**. Their account permissions apply separately from local folder permissions. A separately operated LegalWork server uses its own URL and access token and must remain reachable; its credentials and files belong to that server. Adding a remote agent as a workspace is no longer supported. Treat connection tokens as credentials.

## Keyboard shortcuts

Use Command on macOS and Control elsewhere. In the chat shell: `Cmd/Ctrl+K` opens the command palette, `Cmd/Ctrl+Shift+F` searches sessions, `Cmd/Ctrl+J` toggles the terminal, and `Cmd/Ctrl+T` / `Cmd/Ctrl+Shift+T` moves between session tabs. `Cmd/Ctrl+N` creates a new chat when focus is not inside an editable field. These shortcuts are context-dependent; they are not Office shortcuts.

Related: [Tasks](tasks-intake.md), [Files](files-documents.md), [Troubleshooting](troubleshooting.md).

## Older chats after an update

The first v2 start imports chat history into the new engine and saves verified attachment references, scheduled-message details and chat permission rules in current app storage. The original v1 copy is retained for recovery. Normal chat use then reads the current storage.

An older unfinished Undo is restored only when its original state can be verified. Unsupported partial or file Undo stays blocked with a recovery message. Missing or damaged migration data also blocks execution instead of silently dropping the saved restrictions. Keep the recovery copies and contact support when this happens; deleting app data can remove chats, tasks, schedules and settings.

## Requests with many images

Images keep their original detail when sent to the model. A chat with several large images can exceed the model service's limit for one request even when it is below the token limit. If LegalWork reports that the request contains too much data, use **Revert** on the message before those attachments, or choose **New Chat** and send fewer attachments at once. Compacting text does not reliably remove recent images. Your saved files remain available.

If an assistant calls a tool with invalid arguments, LegalWork gives it correction instructions using the tool's input rules and validation details. This applies to Word, built-in tools, saved-output tools and MCP tools that report invalid parameters. After three identical invalid calls, it receives a stronger warning and can change its approach or explain what information is missing. LegalWork stops that run only if it keeps making the same invalid call for three further assistant steps without progress. Before the final attempt, the assistant receives an explicit warning that another identical validation failure will stop the run. With one call per step, this final warning follows the fifth failure and the sixth failure stops the run. Parallel calls in one step count as one recovery attempt. Permission denials, timeouts and service errors do not count as invalid arguments. The guidance goes to the assistant with its tool result; it is not a separate desktop notification. If LegalWork stops the run, the chat explains that the assistant kept repeating an action with invalid input after a warning. This explanation remains when you reopen the chat. Send a follow-up message to try another approach. Pressing **Stop** yourself still shows **Stopped**. A failed child task can be inspected in the chat before trying again.
