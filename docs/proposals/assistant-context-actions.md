# Context and actions for the universal entry

Status: design extension from user feedback, 23 October 2026; implemented on `codex/assistant-launcher-upstream`, with verification and capability limits in [delivery notes](assistant-context-implementation.md). This extends the [interaction flow](assistant-interaction-flow.md) and [product proposal](global-assistant-launcher.md). Where the earlier flow defaults every question to the general Assistant, the context-based destination rules here take precedence.

## Product behavior

The entry should know what the user is working on, offer useful actions for it, and make the destination of each action clear. The same field finds existing objects, prepares new ones and asks questions. Opening, saving and creating ordinary objects use application operations; an AI call is for work that needs one.

The guiding questions are: **What am I looking at? What do I want to do with it? Where should the result go?** Users should not have to reconstruct that information in a prompt.

Keep these three things separate:

| Concept | Example | Consequence |
| --- | --- | --- |
| Source | Contract from project B, paragraph 7, open in project A | Preserve the real file owner and the passage being discussed |
| Working destination | Project A, current content pane and selected folder | Prefer actions and new project chats here; show this destination |
| Operation | Open, ask, create, save, attach, compare | Determine the actual effect of Enter and whether another choice is needed |

A search result does not change the working destination. A document's source project does not automatically replace the workspace in which it is being viewed. Choosing the general Assistant changes the message destination, not the identity of the source document. Context chips remain individually removable.

## A movable surface

Movement is a functional requirement, including when the entry is invoked inside LegalWork.

- Provide an obvious, usable grip/header area. Do not leave dragging possible only in tiny gaps between buttons. Inputs, context chips, result rows and action controls remain interactive rather than draggable.
- On desktop, use the existing floating launcher window for both global and in-app invocation. The in-app entry supplies the same rich origin context; it should not become an immovable modal with different behavior. Retain an in-page surface for browser-only use and let users reposition it within the viewport.
- Remember user placement per display, keep the panel reachable after display/DPI changes, and offer **Reset position**. Moving between displays must update the saved display association.
- Preserve placement across searches, conversation growth, dismissal and restart. Expanding results should not repeatedly recenter the window or move it under the pointer; adjust only enough to remain usable on screen.
- Dragging must not lose text, select results, dismiss the window or replace its captured context. The native window moving over another application is not a new invocation.
- Keep the continuous neutral border and the absence of the heavy shadow. No pin control is needed for movement.

Current evidence: `launcher-window.mjs` already saves position and `launcher-placement.mjs` bounds it to a display. However, `.launcher-entry` is draggable while all its direct children are `no-drag`; a useful grabbing area is not guaranteed. In-app `LauncherDialog` uses a centered dialog. `savePosition()` records the display ID set on show, rather than recalculating it after a cross-display move. These are code findings, not a native reproduction of the user's report.

## Context captured at invocation

For LegalWork, capture the focused window, workspace/project, pane, active tab, document or chat, selected folder, document revision and selection before opening the launcher. In split views use the focused pane, not whichever project last wrote global state. Retain the last active visible document when focus briefly moves into its associated chat composer.

Show a short context line, for example:

> **Project A ▾** · Contract.docx × · Selected paragraph ×

The destination control offers **New chat in Project A**, the current project chat when applicable, **General Assistant**, and other explicit destinations. Context details reveal the source project, path, selection and version. They should not require reading an implementation ID.

Cheap metadata may be captured locally when invoking the surface. Internal editor selection should be staged visibly; the current document can be represented by its reference rather than reading every open file. Content reaches an agent only with an explicit Ask/Run action. Browsing search results does not add them to context.

For an external application, record the originating app/window. When an authorized selection adapter can read the selection at invocation, stage it visibly. Capture it before the panel takes focus where the platform requires that. Do not substitute old clipboard content when selection capture fails. In that case offer **Paste selection** or an explicit selection-capture action. Whole-page capture and screenshot remain named actions, not background side effects.

An external browser URL/title is available only if a browser integration or supported adapter actually provides it. A window title alone is not a verified URL. Show what was captured and never invent source metadata.

Freeze context once the user starts composing or choosing an action. If the underlying view changes, offer **Use current view** without silently changing a message's destination. A new invocation from project B must not overwrite an unsent project-A draft: offer **Continue draft in A** and **New request in B**, retaining both. Previously submitted follow-ups remain bound to their original chat.

## Destination rules for questions and chats

| Invocation context | Default question destination | What the first send does |
| --- | --- | --- |
| Contract/document focused inside project A | **New chat in Project A**, with document/selection chips | Create one real project-A chat, attach the exact context and submit there |
| Existing project-A chat focused | **Continue [chat title]** | Send into that chat; New chat remains an explicit option |
| Folder or project overview in A, no chat focused | **New chat in Project A** | Create a project-A chat; include the visible folder/project context, not every file in it |
| Foreign document from B displayed in A | **New chat in Project A**; source explicitly says B | Create the chat in A with an authorized reference to the B document |
| Home without a project, or general Assistant focused | **General Assistant** | Resume the selected Assistant conversation; do not create a new independent topic merely by opening it |
| External website/application without an explicit destination | **General Assistant** | Ask with the visibly staged selection; project destinations are selectable, not inferred from a stale last-opened project |
| Explicit Import/Ask in project X action from an external app | **Project X / chosen chat** | Stage in the selected draft, or create a project chat on the explicit send, as the action promises |

Opening the bar creates no chat. Clicking a target picker creates no chat. In a document-origin query, the first send creates a project chat once; follow-up questions stay there. Retrying that send must reuse its operation and chat rather than create another empty chat. The user can choose the general Assistant before sending without retyping.

This is not just a renamed chip. Ordinary launcher messages currently go through the Assistant conversation route; a project target is supplied as context, while the special command path can create a project session. Direct project questions therefore need a real project-chat submission path using the existing session/queue machinery. Do not claim that a prompt asking the general Assistant to delegate is equivalent.

The compact conversation can show a project chat, not only an Assistant conversation. Expanding it opens the exact session in the destination project's chat pane, beside the relevant document where the existing layout permits. No extra native chat window is created for each question.

## Cross-project opening: two clear choices

Searching remains available across accessible projects. The invocation project can improve ranking and be offered as a visible search filter; it must not silently hide all other projects. Every file result names its source project.

If the selected result belongs to the current workspace and there is an unambiguous content destination, Enter opens it there using the existing pane layout rules.

If a document from B is selected while working in A, Enter opens a small destination chooser. The footer already says **Choose where to open**. Enter is not a dead key, and it does not silently navigate away from A. Show exactly the two primary choices:

1. **Open in Project B** — navigate to the original project and open the source document.
2. **Open here in Project A** — open a linked document tab in the current workspace's content pane. The file stays in B; retain a visible source label and default reference/read-only behavior.

Copying into A is a separate action, **Copy to Project A…**, with a destination folder. Moving is another explicit operation. Opening here never silently duplicates, relocates or changes ownership of a file. If the source is unavailable, show that failure instead of opening a different local path with the same name.

When another pane in the same workspace is the only ambiguity, name that destination or offer **Here / Beside**. Follow the user's existing chat/content layout preference. Do not replace an unsaved editor to make room. Once a destination is chosen, retain it through the asynchronous open; closing that pane should trigger a new destination choice rather than redirect to an unrelated pane.

The repository already models source-project file tabs separately from display destinations and can open a source-owned document read-only elsewhere. Reuse that capability rather than inventing a second import mechanism for Open here.

## `doc`: find or create, without a command language to memorize

Typing `doc` (and localized document aliases) offers **Search documents** and **New document…**. Partial autocomplete presents these first, followed by matching items. They are different actions with different labels; ordinary text containing those letters is not rewritten.

After choosing document search, the usual filename/content search applies. For `doc Statement`, the list can include matching documents and a clearly separate **Create “Statement”…** action. Enter on an existing result opens it; Enter on Create opens a short creation form. A late search result or no-results response must not silently turn an Open action into Create.

The creation form contains only the choices needed to make the result concrete:

- Name and supported format, with a recent/appropriate default.
- Project and folder, prefilled from the selected folder; otherwise the active document's folder if it belongs to the destination project; otherwise that project's root. A B-owned document displayed in A never seeds a B save path for an A document.
- Optional existing template or **Draft with Assistant**. An ordinary blank file does not need a model round trip.

The primary action says **Create and save in Project A / Contracts**. Once successful, open the saved file in the intended content pane and show its actual path. Respect the editor's normal autosave behavior afterward. Report name collisions in the same form; do not silently overwrite. On failure retain the form and its text. Retried operations must not produce duplicate files.

For **Draft with Assistant**, keep the chosen destination visible during generation and bind the eventual artifact to it. Show Preparing/Generating/Saving accurately; never claim a file is saved just because model text arrived. Cancellation does not discard an already saved file. Reuse existing templates, file writers and document editors, advertising only supported formats.

## Website selection: from source to useful project work

Example: a paragraph is selected in a browser and the entry is invoked. Show the selection/source chip and a small set of relevant actions:

| Action | Flow | Result |
| --- | --- | --- |
| **Ask about selection** | Type a question; use the visible destination control | Answer in the general Assistant or chosen project chat |
| **Add to chat…** | Pick a project and an existing chat or New chat; retain the selected text | Selection staged in that chat's composer, with provenance, without auto-sending or replacing an existing draft |
| **Save selection to project…** | Choose project/folder, suggested filename and supported format | A saved excerpt file, including available source title/URL and capture time, opened or revealed at the chosen destination |
| **Create task from selection…** | Prepare an editable task with title, project and source reference | A task after the user chooses Create; do not invent or silently apply a deadline |
| **Explain / Translate / Summarize** | Use the selected text as a visible input to that named action | A compact result with Copy, Add to chat and Save to project options |

Saving an excerpt preserves the original selected text and labels it as an excerpt. Summarizing is a different action. Saving the entire page, PDF or screenshot is offered only by a provider that can capture that content; do not call a selection export a full-page save. If a URL is not available, retain the app/title and let the user optionally add a URL.

External capture has no intrinsically reliable project folder. Open/recent projects can be convenient picker suggestions, but a selected destination must be visible before saving. A chosen import action carries its destination all the way to the write, even if the user changes the main app's active project meanwhile.

## A common action vocabulary

Expand capability through a reusable set of verbs over objects, rather than adding one permanent toolbar icon for each feature:

| Object / context | Useful actions |
| --- | --- |
| File / document | Find, preview, open here/original, ask, attach, compare, create from template, save a copy, reveal, copy reference |
| Selected passage | Explain, translate, suggest a rewrite, add to chat, save excerpt, create task |
| Folder | Search within, create document/folder, import selection/files, show recent changes |
| Project | Open, new chat, search its content, show tasks, show ongoing work |
| Chat | Continue, new chat in its project, attach a result, open beside its source |
| Task | Open, edit, complete, ask the Assistant to help, open its source |
| Recording | Open/play, attach to a chat, summarize or create notes when a transcript is actually available |
| Two selected documents | Compare, summarize together, prepare a review in the selected project |
| Generated answer / artifact | Open, copy, insert into the validated origin, save to project, continue in a workpane |

For editing an existing document, show the proposed change and apply it to the exact current document/version. A read-only linked source offers Save a copy or an explicit edit-original route, not a misleading local edit. Task extraction, drafting and comparison can use the existing Assistant/skills; navigation, blank file creation and excerpt saving should use ordinary app operations.

Expose compatible actions first, typically three to five. The rest remain searchable or under Actions. Results and actions are visibly grouped. Stable rows and selection rules take precedence over continually reordering the menu by guessed intent. A question typed in document search can still be sent through the visible Ask action with its actual destination named.

Existing favorites/quick actions can save a recurring object + operation + destination pattern. Run the same registered action through the panel, Home, companion or optional Raycast adapter; do not create four implementations or require users to learn slash syntax.

## Architecture and reuse

Add a typed invocation-context snapshot supplied by the actual source window. It needs origin/window identity, display, focused workspace/pane/tab, document source reference and revision, selected folder, optional selection, chat identity, available capabilities and capture time. Native app identity alone cannot supply internal LegalWork context. The current embedded launcher props also do not pass that context.

Use an action resolver that combines the snapshot, typed text, selected objects and explicit user destination. Its output defines a label, required inputs, source references, destination, deterministic/agent execution, actual primary action and result handling. Freeze that operation once started. UI labels and dispatch must use the same resolved operation, especially for Enter.

Keep search scope, content source, chat execution target, viewing pane and save folder as separate typed values. Carry project endpoint identity through remote/local workspace resolution without placing credentials in links or display labels. Resolve permissions and file revisions through the existing server interfaces.

Provide dynamic app/document context as per-turn context using the existing reminder mechanism, not as a changing system prompt. Capture active editor text when requested and supported; distinguish unsaved editor content from the last saved file revision. If unsaved content cannot be captured, say so and offer Save current document or Send selection. Do not present stale disk content as what the user sees.

Reuse the draft coordinator and idempotent submission path for both Assistant and project chats. Keep document operations, source references and panel opening in their existing domains. New create/save actions also need idempotent operation IDs, no-clobber writes and a recoverable pending state. Do not put the entire routing policy into another set of effects in `launcher-panel.tsx`.

Relevant existing code:

- [Native window](../../apps/desktop/electron/launcher/launcher-window.mjs), [placement](../../apps/desktop/electron/launcher/launcher-placement.mjs), [drag regions](../../apps/app/src/react-app/launcher/launcher.css), [in-app dialog](../../apps/app/src/react-app/launcher/launcher-dialog.tsx).
- [Pane state](../../apps/app/src/react-app/domains/session/panel/panel-tab-store.ts), [destination requests](../../apps/app/src/react-app/domains/session/panel/panel-tab-request.ts), [opening layout](../../apps/app/src/react-app/domains/session/panel/workspace-opening.ts), [visible document targeting](../../apps/app/src/react-app/domains/session/panel/document-control-target.ts).
- [Cross-project file context and new chat](../../apps/app/src/react-app/domains/workspace/project-file-context.tsx), [source-owned document panel](../../apps/app/src/react-app/domains/workspace/project-file-panel.tsx), [source file tab](../../apps/app/src/react-app/domains/workspace/project-file-tab.ts).
- [External origin/selection](../../apps/desktop/electron/launcher/origin-service.mjs), [capture staging](../../apps/app/src/react-app/launcher/context-capture.ts), [invocation and context types](../../packages/types/src/launcher.ts), [current Assistant submission routing](../../apps/server/src/routes/assistant-conversations.ts).

## Delivery dependencies and acceptance

These dependencies order the full capability set; they are not a reduction to a separate chat widget.

1. **Window and origin:** reliable dragging/placement; one desktop surface; focused-pane context bridge; visible source and destination; retain the prior flow fixes for input, Back and Assistant resume.
2. **Correct routing:** direct project chat with document context, general Assistant override, follow-up continuity, cross-project destination chooser and exact expand target.
3. **Object operations:** `doc` search/create, seeded destination folder, Save selection to project, Add selection to chat; retries and errors preserve work.
4. **Contextual action breadth:** source-linked tasks, compare, rewrite, templates, recordings and reusable quick actions, each using real provider capabilities and the same action resolver.

Acceptance scenarios:

- Drag the panel away from the contract in both global and in-app entry; reopen, restart, move to another display and disconnect that display. The panel stays usable and remembered placement does not depend on a tiny gap between buttons.
- Invoke over a selected clause in project A: the destination and document/selection are visible. First send creates exactly one A chat; follow-ups and retries reuse it. Choosing General Assistant uses the same typed question without creating the A chat.
- Focus each of two split panes and invoke: capture the pane actually used. A background refresh or the overlay gaining focus never changes the destination.
- Leave an A draft, invoke from B, then switch the underlying window: the draft is preserved and no send silently changes projects.
- From A, select a document from B: Enter shows the two destination choices. Open here leaves the file in B, labels its source and does not overwrite an unsaved A editor. Asking about it defaults to A with B as the content source.
- Type `doc`, find an existing document, then choose New document: the right folder is prefilled. The final create action produces one saved file and opens it; an identical filename or retry cannot overwrite/duplicate silently.
- Select web text, import it into an existing chat, and save it as a file in a project folder: the exact excerpt and available source metadata survive. Existing chat drafts remain intact.
- Disable a selection adapter, change a document revision, remove a destination pane or lose connectivity: present the actual missing capability or changed destination, retaining the request instead of acting on a stale substitute.
- Verify the same operation from a shortcut, in-app entry and companion. Switching entry points does not change its semantics or lose context.

Implementation validation must cover these state transitions and the existing draft, queue, document and permission contracts. Native UI tests remain with the user; restart the local application after runtime changes. The delivery notes distinguish code verification from the native acceptance scenarios still to be exercised by the user.
