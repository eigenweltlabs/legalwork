# Assistant interaction flow

Status: design revision based on the user's hands-on feedback, 23 October 2026. The behavior below is the implementation contract. See [delivery notes](assistant-context-implementation.md) for the implemented changes and verification. This revision takes precedence over conflicting interaction details in the original [product proposal](global-assistant-launcher.md). It does not remove existing conversations, files, work or capabilities.

Follow-up: the [context and actions extension](assistant-context-actions.md) adds a movable surface, focused-project/document context, direct project chats, cross-project opening, document creation and website-selection import. Its visible destination rules supersede the earlier assumption that every question goes to the general Assistant. Shared input preservation, deliberate submission and layered Back still apply.

## Findings before the revision (23 October)

The Assistant foundation in PR #232 has one personal Assistant workspace and an internal engine context per local day. Its history UI presents the older days. Our launcher added independent conversation records and changed Home navigation to use their resolution and draft coordination. The independent conversation capability is therefore our addition, not an existing #232 window model.

The current launcher exposes that addition in the wrong place: its ordinary **Assistant** row calls `startNewConversation`, while another row resumes the currently bound conversation. The same Assistant therefore has two competing entry points, one labeled like a destination but behaving like a context reset.

The checklist icon in the input bar opens `LauncherWork`: running/delegated agent jobs, requests for input and returned results. It is separate from the **Tasks** search category. The difference is meaningful, but an unlabeled icon does not communicate it.

Sending the current search text to the Assistant already has a keyboard path: Cmd/Ctrl+Enter calls `submitAsk` even with a file category active. The visible Ask control promised by the product proposal is missing. Users should not need to discover a shortcut to escape a search mode.

Other relevant findings:

- The idle list can mix a resume row, a new-conversation row, five categories, five saved searches, four favorites and four conversation-history entries without a clear hierarchy.
- Tab executes any selected navigation row, not only autocomplete. On the idle view it can open a conversation instead of moving focus.
- The filter menu mixes search scope/type/date with the execution target for a message.
- `expand()` writes the current input into a conversation draft even when the visible surface is search, provided a conversation is bound. Expanding search and expanding a conversation need different routes.
- `chooseCommandContext()` creates a conversation when a user merely chooses where commands belong.
- `AssistantConversations.current()` chooses by last update. That does not establish a durable, explicitly selected conversation shared by every surface.
- Full-window Home still has a prompt-oriented welcome form and suggestion cards, while the launcher starts with search. Sharing a submission backend alone does not make these a consistent entry experience.

Evidence: [launcher panel](../../apps/app/src/react-app/launcher/launcher-panel.tsx), [Home navigation](../../apps/app/src/react-app/launcher/assistant-navigation.ts), [Home](../../apps/app/src/react-app/domains/session/home/app-home.tsx), [conversation resolution](../../apps/server/src/assistant-conversations.ts), [conversation routes](../../apps/server/src/routes/assistant-conversations.ts), [work monitor](../../apps/app/src/react-app/launcher/launcher-work.tsx). The #232 comparison used commit `aee752e8`.

## Product decisions

1. **One personal Assistant, with real project chats.** Choosing the general Assistant resumes its selected conversation. A document-origin request can instead start a chat in the visibly selected project on first send, as specified in the context extension. Opening a surface, choosing a destination, changing a filter or browsing commands never creates a fresh topic.
2. **Search can always become a request.** Every non-empty search offers a labeled Ask action naming its destination: **Ask Assistant** or **Ask in Project A**. It uses the text already written. Cmd/Ctrl+Enter is an accelerator for that same action.
3. **Selection and submission are separate.** Highlighting a file neither attaches it nor sends it to a model. A search category does not choose the execution project.
4. **Every transition preserves work.** Search input and an Assistant draft are different objects. Switching surfaces or intent must not overwrite either one, including their attachments and a pending submission.
5. **One operation, one visible result.** A category opens its contents, an item opens its default destination, a command previews or executes its named action, and Ask submits a message. No silent context reset or project creation accompanies navigation.
6. **Controls belong to their current purpose.** Search filters appear in search; the message destination belongs to the composer. Work status appears when it has something useful to report. Secondary actions live in a labeled menu or result action list.

Independent conversations remain accessible to avoid losing existing work. Expose **New topic** in Assistant history/its secondary menu, with the same availability in the full window and panel. It starts a separate conversation with the same Assistant, not a second Assistant or a new native window. Explain its fresh message context without promising isolation from shared Assistant tools or memory. Keep existing daily history readable. Do not change daily/cloud execution semantics as a side effect of this UI revision.

## Start surface and Home content

The compact start view is a navigation surface. The full-window Home uses the same entry semantics and selection/action rules, with room for more detail. In an actual conversation, the field becomes its message composer. First-time account/provider setup remains a separate onboarding flow. The ordering below describes global Home; when invoked in a project/document, the visible destination and a small set of source-specific actions precede generic navigation, according to the context extension.

Use this hierarchy, hiding empty optional sections:

| Order | Content | Default action and value |
| --- | --- | --- |
| 1 | **Continue with [Assistant name]**, with a short last-message or draft preview; **Ask [name]** if no conversation exists | Enter the same conversation; reveal its saved draft. One obvious way back to the Assistant. |
| 2 | At most two requests that need an answer, each naming its project and work item; **Show all** for more | Open the exact request. Do not present a generic Approve action or execute approval from row selection. |
| 3 | **Files · Projects · Chats · Tasks · Recordings**, as selectable rows with optional alias hints | Browse real content immediately, without requiring a search term. |
| 4 | Up to three recent or explicitly favorited items, grouped under **Continue working** | Open the exact item, with its kind and project visible. Deduplicate with the Assistant resume row. |
| 5 | A compact **Assistant work: 2 running · 1 ready** row, only when there is relevant work | Open the work monitor. This is not another Tasks category. |

Saved searches belong to their category or a **Saved searches** entry; do not dump five of them into the first screen. Conversation history belongs behind **History**, with a link from the Assistant surface. Full Home may show more recent work below the same core entry, but should not become an unrelated card dashboard.

For a genuinely new user, show the Assistant entry, categories and one short instruction. Optional concrete examples can prefill the field; they never submit. Do not invent recent files, running work or recommendations that require an invisible model request.

When typing begins, matching categories and results replace the start content. Unrelated history and large attention cards must not push results below the fold. Keep an unobtrusive, labeled indication of pending requests available.

## State and transition map

| Current state / user action | Next state / visible behavior | What is retained | Value of this step |
| --- | --- | --- | --- |
| Invoke from any app, shortcut or microphone menu | Restore the in-progress panel state, or show Start on first use; focus the field | Unsent text, chosen conversation, staged files, return destination | Available immediately without having to choose a project |
| Start → Assistant | Show the current conversation, or an empty Assistant composer on first use | Existing draft and history | Continue work rather than accidentally reset it |
| Type ordinary text | Search across available sources; show Ask Assistant beside the results | Exact text, selection/caret where possible | Find an item or express a request without deciding the mode first |
| Type a category name, or choose its autocomplete | Show that category's actual results and a removable category chip | The remaining query | Narrow the search in one action |
| Choose Files with no query | Show recent/available files and search coverage | Search scope, if explicitly chosen | A useful browser before typing |
| Ask from search, including Files | Submit exactly the current text to the visible Assistant/project-chat destination and show that request/conversation | Search snapshot for Back; any pre-existing conversation draft independently | Correct an initially chosen intent in one action |
| Highlight a search result | Show selection and its primary action | Text and scope; no added context | Make the next action predictable |
| Enter on an item | Open the item's advertised default destination, or its explicit destination chooser for cross-project results | Recoverable launcher state | Finish navigation with one key when unambiguous; choose a destination when needed |
| Right Arrow or Actions on an item | Show actions valid for that item | Selection, scroll position and query | Offer capabilities without crowding every row |
| Attach / Ask about a file | Stage the explicitly chosen file(s) in the Assistant composer and focus it; do not send yet | Typed request and any existing draft; visible file provenance | Turn a found item into useful context without accidental submission |
| Compare / Summarize selected files | Prepare the matching request with all selected files in the composer | User edits and staged context | Reduce composition work while keeping the request inspectable |
| Send from conversation | Show the user's message and pending/streaming response in that conversation | Submission identity and any text typed after sending | Clear feedback without duplicate sends |
| Expand a conversation | Open that exact conversation and complete draft in the main window | Conversation/session identity, attachments, selection, pending submission | More room without restarting the interaction |
| Expand search | Open the same search in the main window | Query, category, scope and filters | More room for results; no search text inserted into a chat draft |
| Open Tasks / type tasks | List actual tasks with project/status information | Search state and filters | Answer the user's request to see tasks |
| Open Assistant work | Show running, waiting and returned agent jobs | Previous view and draft | Answer what the Assistant is doing, separately from the user's task list |
| Open a job's question/result | Show that exact item and its destination | Job identity and return route | Let the user unblock work or collect its result |
| Choose History → existing topic | Open its original conversation and draft | Current topic's draft before switching | Recover previous work without merging contexts |
| Choose History → New topic | Show a fresh composer for the same Assistant | Old conversations and outstanding jobs | Separate a topic only when the user requests it |
| Dismiss, switch app or sleep | Hide the surface; preserve drafts and running work | All persistent work state | Let the user continue elsewhere |
| Restart | Restore recoverable drafts and output status; report interrupted work truthfully | Durable identities and saved context | Recovery without claiming the model continued running |

No new native chat window is created for a new topic. The existing main window and compact panel are the two presentations.

## Search to Assistant: the non-negotiable path

Example: the user is in **Files** and types `Summarize what is still open in the Müller matter`.

1. The query stays visible. Search results may appear; the field is still editable.
2. A labeled Ask control names the current destination (**Ask Assistant** or **Ask in Project A**) beside the entry/results, with Cmd/Ctrl+Enter as its hint. It remains available if the search is loading, empty or offline.
3. Clicking it or using its shortcut submits that exact text to the visible destination. A committed `f` chip is navigation metadata, not part of the message. Never rewrite uncommitted prose by guessing what was a category keyword.
4. No highlighted result is attached automatically. Explicitly staged files/selection appear as context before submission. A file search filter never silently becomes a project execution target.
5. The panel shows the request and its response. Back returns to the original Files query and filters.

If the Assistant already has an unsent draft, the search request uses a separate submission payload and leaves that draft intact. Do not overwrite it with the search text, silently append the two texts, or require the user to erase either. If another request is running, use the existing queue and show the queued state.

Ordinary Enter in search opens the selected result. **Ask** is only an Enter target after the user explicitly selects that action. No-results or a slow provider must never change Enter into an unexpected model request. Do not auto-classify question-shaped text into submission.

Offer **Edit with Assistant** as a secondary action when the user wants to review a request before sending. If that destination already contains a draft, retain both and make replacement/combination explicit. This should not obstruct the direct Ask path.

## Keyboard and Back contract

| Key / action | Contract |
| --- | --- |
| Up / Down | Move through the current visible rows, including Start; scroll the selected row into view. Later provider results preserve a deliberate selection by ID. |
| Enter in search | Perform the selected row's visible action. No selected row means no implicit send. |
| Cmd/Ctrl+Enter in search | Ask using the current text and explicitly staged context, regardless of category. |
| Enter in a conversation | Send according to the main composer's existing preference; use the same newline behavior. Respect IME composition. |
| Tab | Complete a visible category/command suggestion when completion is applicable; otherwise move focus normally. Never start a conversation or execute a navigation row merely because it is selected. |
| Right Arrow | Open item actions only when the caret is at the end, no text is selected and an actionable result is selected. Otherwise keep normal text editing. |
| Backspace at the start | Remove the category chip while preserving query text. |
| Escape in menu / preview | Close only the innermost layer. |
| Escape in a conversation / work detail | Return to the prior surface with its original input, selection and scroll; persist the conversation draft first. |
| Escape in search | Clear the query first, then explicit filters/category, then dismiss the empty Start surface. Conversation drafts remain independent. |
| Clicking outside | Dismiss without sending, cancelling work or discarding the draft. Native chooser/menu operations keep their existing focus protection. |

The footer describes the selected action and the one or two useful alternatives. Avoid a permanent legend of every shortcut. The direct Ask action is labeled and clickable, not available only through footer trivia or hover.

## Controls and special flows

**Search filters:** category, project search scope, file type and modified date. Only offer type/date filters where they affect visible file results. Removing the category does not erase the query. Execution destination is shown in the Assistant composer, separately from search scope.

**Assistant work:** remove the permanent checklist icon from the entry bar. Use the labeled status row when work exists and a searchable **Assistant work** navigation action at all times. Keep the existing monitor and its capabilities. Opening a work item preserves Back. Stop, redirect and approval remain specific to the named job/request.

**Slash commands:** in a conversation, show commands for its explicit Assistant/project destination. At the root, allow browsing commands after choosing a visible destination; browsing or choosing that destination must not create an independent conversation. Autocomplete prepares arguments; only a deliberate Run executes. File search must remain able to search literal path text instead of interpreting every leading slash as a command.

**Capture and attachments:** the add menu, drop and paste feed a visible staging area with source labels. A screenshot or attachment never sends automatically. Direct Ask includes only explicitly staged context. Empty text plus files can open a composer, where the user chooses what to ask. Existing attachment errors retain successfully staged items and show which need retry.

**Microphone companion:** its hover menu has three labeled destinations: Dictate, Record meeting, Assistant. Assistant opens/resumes the panel. The microphone inside the Assistant composes into that conversation; it does not switch recording ownership silently. Existing record/dictation controls and hotkeys remain intact.

**Calculator:** a recognized calculation shows its local result and a Copy action. It does not send to the Assistant or mutate conversation context. Ask remains an explicit alternative if the user wants an explanation.

**Result output:** show the concrete Open/Copy/Insert actions supported by the returned artifact. Preserve original-app validation and existing restart recovery. Dismissing the panel never cancels a job; opening a result never implies a new task.

**Unavailable states:** Assistant unavailable must not block file navigation. Search unavailable must not disable Ask. Show the relevant failure, preserve input and offer retry. Partial search coverage is visible. Do not present delayed submission acknowledgement as definitive failure or clear a newer draft on acknowledgement.

## Implementation boundaries

Replace the current overloaded input transitions with explicit operations shared by Home and panel:

- `searchState`: query, category, scope, filters, selected result and scroll position.
- `activeConversationId`: the user's selected conversation, distinct from whichever conversation most recently received a background update.
- `conversationDraft`: the existing authoritative draft per conversation, with attachments, destination, revision and submission identity.
- `stagedSearchContext`: attachments deliberately added before entering a conversation; never silently inferred from result selection.
- `navigationStack`: the concrete previous surface and its search/detail state.

Use operations such as open/resume Assistant, start an explicit topic, ask from search, attach to composer, open work and expand the current surface. Each operation defines which object it reads and which it can update. Do not implement intent changes by clearing a shared string or changing view flags until effects happen to converge.

Reuse the existing draft coordinator, submission identity, server-owned Assistant, search providers and work endpoints. Preserve their race/retry protections. Resolve the same active conversation through a shared service for the panel and Home; keep an open conversation bound across midnight and screen expansion. Adopt a new daily context only through the foundation's deliberate routing policy, not through a visual transition.

Do not delete existing independent conversations or replay their messages into one huge thread. Give every old conversation an accessible history entry and preserve job-origin links. This UX revision does not change connector permissions, model memory promises or the DCO/base cleanup process.

## Delivery order and acceptance

Implement as coherent transitions, not another round of isolated labels:

1. **Conversation identity and entry:** normal Assistant resumes; explicit New topic is secondary and works in both surfaces; history remains accessible. Opening Start, selecting a category, or choosing command context creates zero conversations.
2. **Input preservation and Ask:** separate search state from draft state; expose Ask in every search category; preserve a pre-existing Assistant draft. Add regression tests for slow initial binding, concurrent typing, an existing draft, empty results and pending submission.
3. **Home and keyboard:** grouped Start content, real category browsing, deliberate autocomplete and Enter behavior, labeled work entry, layered Back. Avoid placeholder content and duplicate Assistant entries.
4. **Surface continuity:** search expansion preserves search; conversation expansion transfers the exact conversation/draft; reopening and topic switching do not lose text or files. Preserve existing attachment and output recovery. Include a usable drag area and shared movable desktop surface, followed by the context/routing dependencies in the extension.

Acceptance scenarios for the user (native UI testing remains with the user):

- Open the Assistant ten times from Start, the companion and Home: the same current conversation opens; no ten empty topics appear.
- Leave a draft with a file in Home; ask a different question from Files in the panel: the question is submitted once and the original draft/file still exists.
- In Files, type a full request and click Ask: no delete, copy/paste or mode-key ritual; Back restores the original search.
- Type `tasks` and use arrows/Enter: see and open actual tasks. The running-work entry is labeled and distinct.
- Tab through the idle view: it never creates a conversation. Complete `f` or a matching category without executing unrelated selected rows.
- Search, open preview, open actions and press Escape repeatedly: each step returns one layer; selection stays visible and stable.
- Stage files, expand, type more in Home, reopen the panel: text/context are consistent and no stale writer overwrites newer edits.
- Expand a file search while an Assistant draft exists: the main window shows that search and the Assistant draft is untouched.
- Create an explicit new topic, switch to history and return: both drafts and outstanding jobs remain available, without another native window.
- A provider times out, a request is queued, or acknowledgement is delayed: the UI shows the relevant state and keeps the user's work.

Run the relevant existing conversation, draft, submission, query, navigation and keyboard tests plus type/i18n checks when implementing. Add behavioral regression tests for these transitions, not snapshots of the component source. Restart the local application after application changes as requested. Do not claim this document itself fixes the runtime behavior.
