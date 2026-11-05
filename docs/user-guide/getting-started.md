# Getting started

Open in LegalWork: [Home](legalwork://app/home), [Account](legalwork://app/settings/account), [AI Providers](legalwork://app/settings/ai).

## Set up the app

1. Install and open the desktop app for your operating system. On macOS, move LegalWork to Applications before launching it. Keep the installed app in a stable location so OS permission grants keep working.
2. Follow the welcome screens. Folder access, audio setup and Office setup can require separate permissions. On **Save logins for the in-app browser**, select your country and the research websites you use, then save your own login for each website. Browser use allows your agent to use these websites too. See [research database setup](integrations.md#research-databases). Skip optional capabilities you do not need and configure them later in Settings.
3. Open **Settings > AI Providers** and connect a provider, or use **Settings > Account** for your firm's Eigenwelt sign-in. Enter credentials in the connection form, not in a chat. An Eigenwelt account and a separately connected model provider are different connections.
4. Add or select a local folder from the sidebar. This is the workspace where the assistant reads files and saves outputs. Use **Settings > Permissions** to authorize additional folders when needed.
5. Choose **New Chat**, select an available model, and state the task. Attach a file or mention a workspace file with `@`. For example: "Read this agreement and identify the termination provisions, citing the clauses."
6. Review the assistant's output and any permission request. Open output file links in the document panel. A chat response is not proof that a file was saved: check the named output and any tool errors.

Opening a project does not require a separate setup approval. LegalWork loads the project's settings and available tools automatically. Firm policies, allowed folders and permissions for individual actions still apply. Install skills, workflows and connectors through LegalWork, and manage access in Settings.

## Set up meeting recording

On the **Record meetings.** welcome screen, open setup and complete the permission prompts. Available cloud regions appear first, with a cloud option selected by default. Cloud transcription runs in your selected region with zero data retention (ZDR). Local transcription requires a model download and uses your computer’s CPU power. Select your source and choose **Continue**; an installed local model is reused.

On the final setup screen, **Meeting Summarisation** appears first and defaults on for cloud transcription, off and unavailable for local transcription. **Detect meetings** defaults on where supported and offers to record detected calls; recording still starts only when you choose **Record**. Review these choices and select **Done**. On a configured profile, **Set up again** reopens recording setup without deleting recordings or resetting granted permissions. Opening setup does not change saved choices; **Continue** applies the transcription choice and **Done** saves the final options.

## Choose a suitable surface

Use a chat for drafting, research or a question. Use **Tasks** for work that needs an owner, status, due date and attachments. Use **Workflows** for reusable drafting or review instructions and firm templates. Use **Evaluations** to measure model performance on explicit criteria. A benchmark task, a work-list task and a chat are separate records.

The [screen map](screens.md) also covers project pages, Calendar, Scheduled, native Tabular Review, Wiki and dashboards where available. Use Calendar to track deadlines, Scheduled to start work later, and Tabular Review to apply questions across documents. None is implied merely by having a due date or a reusable workflow.

The desktop app supplies local folders, document panels, native integrations, recording and Office setup. A browser connected to a remote worker can use that worker's capabilities, but does not gain access to the browser user's local folders or desktop automatically.

## Help and recovery

Ask "How do I connect a network share?", "Where do I change the app language?", or "Why is the Office add-in unavailable?" The assistant can load the help skill and read the local manual. For failures, include the exact error and the control you used. See [Troubleshooting](troubleshooting.md).

Related: [Models](models-fusion.md), [Files](files-documents.md), [Permissions and privacy](settings-privacy.md).
