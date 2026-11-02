# Personal Assistant

The Assistant is included with an active **Plus** or **Pro** plan, including
trials. Sync and using your own model do not include it. No separate add-on
is needed.

Without an eligible plan, click **Assistant** in the sidebar, then **Explore AI
plans**. Choose **Plus** or **Pro**, complete the upgrade, and return to LegalWork.
The app checks your subscription and opens the Assistant once access is active.
If you already subscribe, use **Sign in** on the plan screen with that account.
**Maybe later** closes the introduction without changing your subscription.

If your plan ends or you sign out, Assistant messages, delegation, scheduled
Assistant work and proactive checks pause. Your saved conversations stay
available, and you can still stop delegated work. Reconnect an eligible account
to continue; ordinary project chats with your own model remain available.

Open **Assistant** in the sidebar to coordinate work across your projects. On
first use, choose a name and appearance. Each calendar day has its own chat;
earlier conversations remain available in Assistant history.

After reopening the app, your saved Assistant conversation loads while account
and model updates continue in the background. If a new day has started, the app
shows your previous conversation until today's chat is ready. Sending a message
still checks your current access and uses today's chat.

The Assistant receives your name, email address and organization from your
signed-in LegalWork account when available. It updates this context when you
switch accounts or sign out. Your account profile is separate from the name
and appearance you choose for the Assistant.

To show or hide the Assistant entry, open **Customize navigation** using the
gear at the top of the sidebar. Under **Chat sidebar**, toggle **Your assistant**
below **New Chat**, then choose **Done**. This only changes sidebar visibility.
To change its name or avatar, click the assistant at the top of its conversation, or open
**Settings > Assistant**. You can also ask in chat, for example, “Call yourself Maya.”
During first setup, saving the name shows the appearance picker in the conversation.
Renaming later keeps the current appearance.

To choose the Assistant's model, click its name or avatar at the top of the
conversation, expand **Advanced**, and change **Model** or **Thinking effort**.
These preferences save automatically and apply to the next message. They stay
with the Assistant across daily chats and app restarts. Changing a model in a
regular chat does not change the Assistant's preferences, and changing the
Assistant's model does not change the default for regular chats. The home
screen uses the Assistant's preferences when no project is selected.

The Assistant uses one conversation tab. Subagents work in the background until
you open the small subagent toggle at the top of the chat and choose one. Their
tabs keep their own titles and close when the run finishes. You can reopen a
completed subagent from the same list to inspect its result. Opening another day
reuses the Assistant tab without replacing an open subagent.

When the Assistant is idle, your message appears in the chat as soon as you press
**Send**, including while attachments are uploading. Delivery continues in the
background. While it is busy, new messages stay in the editable queue above the
composer until their turn starts; they do not also appear as sent bubbles. If sending
fails, your draft stays available and the chat shows the delivery error.
Choose **Steer** beside a queued message to have it considered at the next model
step without stopping the current work. Other messages and the queue's pause
state stay unchanged. See [Steer with a queued message](workspaces-chats.md#steer-with-a-queued-message).

Use the microphone button beside **Send** to dictate a message. Stop dictation
to review the text, or use its **Send** button to send it directly.

Hover over a message to see its time and copy button, or edit your own message.
These controls appear below the message without shifting the conversation.
You can also reach them with the keyboard.

Animated dots appear only while the Assistant writes a message to you. They stay
off during thinking, tool calls and waiting for delegated work. Each reply
arrives as a complete bubble, and the dots disappear as soon as that text is
finished, even if background work continues. They also stop when a run is
stopped or needs your answer or approval.

The Assistant uses emoji reactions on the left edge of your bubble for brief
acknowledgements, especially confirmations, answers to its questions and retries.
You can also ask for a specific reaction, such as “heart this message.” This
reacts to your current chat bubble and does not change any email or other record.
For example, a reaction to “yes” replaces a separate “I’ll do that” message,
including when work is delegated. Its next message carries the result or a
necessary question. Reactions mean receipt, not approval or completion, and
only appear before it replies or starts work. Reactions and the Assistant's
coordination tools are available in the Assistant workspace, not ordinary
project chats. Delegated workers do not react to your messages.

The Assistant remembers details you provide, such as your phone number, contact
email and booking preferences, in `.legalwork/user-details.md` inside its own
project folder. It checks these notes before asking again and can reuse relevant
details across days and app restarts. Tell it when a detail changes, to forget it,
or to use something only once. It passes only the details needed for the requested
work to a worker. These notes are separate from its follow-up conditions.

Ask the Assistant to find a project, check tasks or calendar entries, or delegate
work to a project chat. Delegated research and scheduled work run in separate
sessions and return their results to the Assistant. Permission requests remain
yours to answer; delegation does not grant additional project access.

Once a final result returns, the Assistant stops watching that delegated chat
and its subagents. Continuing an unrelated conversation there will not send
updates back to the Assistant. Ask the Assistant for a follow-up to start a new
round of delegated work. Pending questions and approvals keep the current round
open until the work returns a final result.

## Browser work

The Assistant delegates all browser work, including short website tasks, to a
browser worker. This keeps the conversation available while the worker uses a
separate model, independent of the model you choose for the Assistant.
The **Automatic** default chooses the first available model in your Eigenwelt
subscription in this order: **GPT-6.1 Terra**, **Claude Sonnet 5.5**,
**Gemini 3.8 Flash**, **GPT-6.1 Sol**, **Claude Opus 5.5**, **Gemini 4 Argon**,
**GPT-6 Luna**, **DeepSeek V4.1 Flash**, **GLM 5.3 Flash**, then **Mistral Large 4**.
Models disabled by your firm are skipped. When both EU and US variants of the
same model are available, EU is preferred; unavailable regions are never added.
Terra Fast is also recognized. If none is available, browsing waits for you to
refresh your models or choose a connected browser model explicitly.
The setting shows the model chosen from this order, with an **Automatic** label.

Click the Assistant at the top of the chat, expand **Advanced**, and choose
**Browser model**. You can also change it under **Settings > Assistant**. Changes
save automatically. An explicit choice takes precedence over Automatic. If that
model becomes unavailable, LegalWork asks you to change it instead of substituting
another model. Use **Use automatic browser model** to return to the default order.

The worker's browser appears as a small preview tile in the main Assistant chat,
including when the worker started in an earlier daily chat. Its own chat stays
closed unless you open it. Workers do not send desktop notifications; only the
Assistant's replies to you can notify you.
Click the tile to open that actual browser beside the
conversation. The preview disappears when its worker finishes or stops; a browser
you opened yourself stays open. Tiles remain while a worker is waiting for your
answer or approval. Background browsing does not switch your screen. Existing website
permissions and approval requirements still apply.

## Relevant updates

The Assistant can send you a new message when something relevant changes, even
while you are not chatting. It keeps its own concise scratchpad of important
recent topics, things you asked to hear about, and specific developments it wants
to bring back to you. There is no list you need to create or maintain. Tell it
"let me know when Alex sends the signed agreement" or "stop updating me about
that matter" and it updates its scratchpad itself. When you say you are waiting
for an email and ask to be told, it checks now and keeps an eye out if it has not
arrived. You do not need to repeat the request or configure an alert.

You can also ask for work when a condition occurs, for example: "When a new
client intake request arrives, create a project and use my intake workflow."
The Assistant records the condition itself and uses the existing email checks,
without creating a separate recurring inbox task. It uses the installed skill's
configured templates. Details about the future client are resolved when the
request arrives, rather than blocking setup.

Background updates stay in the language of your Assistant conversation, even
when an email or document is in another language. Each update explains what
arrived, who sent it and what it asks for, then gives you the prepared result and
any remaining actions. It includes a source link when available.

For requested intake work, the Assistant prepares the parts supported by the
available information and brings back a draft with missing details clearly
marked. An unknown client name does not stop independent preparation. It still
needs the represented side before party-specific legal analysis, and cannot
complete required approvals or checks on your behalf. Questions that can wait
come with the prepared work; it asks earlier when no useful work can proceed
without your answer or a decision is time-sensitive.

While LegalWork is running, it checks new or changed tasks, project calendar
entries, and newly received mail and calendar changes from activated Gmail,
Outlook, Google Calendar and Outlook Calendar accounts about every three minutes.
To connect an account, open the connector’s **+** button, select the connector and connect
it. Account-wide mail and calendar checks require **Settings > Assistant >
Project access > All projects**. Project checks follow the Assistant's project
access settings.

EU Jev scores every change collected in each interval for relevance to the
Assistant's scratchpad. Once the whole interval has been checked, the Assistant receives
results scoring at least 65% together and decides whether one short message would help
or whether to stay quiet. Without an explicit match, it is not interrupted. Active
conversations and outstanding questions or approvals take priority. These
updates do not authorize additional work by themselves. If you explicitly asked
for work when a condition occurs, the Assistant can carry out that scope with
its usual tools and permissions, including delegating a skill to the appropriate
project. For a new matter, it starts a new project chat and brings you the result
when that work is ready. It stays quiet while the work runs, unless it needs your
answer or approval or encounters a blocker. It checks for existing work to avoid
duplicates. Actual approvals remain required; an email cannot grant permission. Recurring conditions stay
active until you cancel them, and the Assistant removes fulfilled one-time
conditions.
The existing desktop notification preference applies to new Assistant messages.

Checks require a connected source and an available EU decision model. If a
source or model is unavailable, the check waits and retries. An empty scratchpad
means there are no follow-ups being checked. Closing LegalWork stops the local
checks until it runs again. Saved follow-ups resume after restarting, including
in the next day's Assistant chat, with the access available when you requested
them. Later access restrictions still apply. Follow-ups saved by older versions
without that access record need you to confirm the request once in the Assistant;
the app keeps undelivered events queued until then. Timed checks, such as revisiting a website in five
hours, still use normal
[scheduled tasks](scheduled-tasks.md).

## Briefings and visual reports

Ask for a morning briefing, matter overview or dashboard. The Assistant can deliver a dated report, a dashboard, or a Markdown document with an embedded chart. It chooses a document when the result benefits from more space than a chat reply.

After a few useful exchanges, the Assistant may suggest a morning briefing if
you do not already have one. It proposes a time and days, then creates the
schedule only after you agree. A refusal is remembered, and deleting the
schedule does not cause another automatic offer. You can ask for one later.
Open its saved task card or **Scheduled tasks** to change, pause or delete it.
The briefing includes accessible recordings and transcripts, email, calendar
and tasks. The Assistant's scratchpad helps it prioritize topics without hiding
other important commitments.

A morning briefing can combine an overview of actions by matter, priority emails with links to their original messages, and a checklist grouped by matter. Email requires an authorized connected account. The Assistant uses recorded owners and dates, preserves checked items and your notes on updates, and avoids repeating existing tasks. A daily briefing is a snapshot of the information checked when it was prepared.

Select the document card, or **Open** on it, to open a tab beside the conversation. Preparing or sharing a report does not open a tab automatically. Markdown briefings remain editable and follow the editor's autosave setting. Embedded charts have an **Open in tab** button for a larger view. The report toolbar shows whether the data is a snapshot or a live dashboard and offers refresh, export and save-copy controls.

Shared document cards remain available when you reopen the conversation,
including documents shared while the Assistant was doing several actions
together. A card for a project deliverable opens that project's original file.

Scheduled morning briefings use the same layout and share one primary document card. An unchanged built-in briefing schedule receives the new instructions automatically; custom schedule instructions are preserved. To use the layout in a custom schedule, ask it to prepare a visual morning briefing with an embedded matter chart and linked priority emails and tasks.

Related: [Dashboards and reports](dashboards.md), [Files](files-documents.md), [Scheduled tasks](scheduled-tasks.md).

## Settings

Open **Settings > Assistant** to change its appearance, add custom instructions, or choose Plugins, Workflows and Skills
it should know about. Selections supply descriptions and references; workers
load the resources when doing the work.

Under project access, choose all projects, no projects, only selected projects,
or all except selected projects. These restrictions also apply to delegated
and scheduled Assistant work. Use **AI Providers** to configure its models.

The conversation shows date dividers only for days with visible messages, shared files or setup content. Empty days and days containing only background activity are skipped. Today’s divider appears once today has content.
