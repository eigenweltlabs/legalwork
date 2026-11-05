# Wiki and firm knowledge

Open in LegalWork: [Wiki](legalwork://app/wikis).

A wiki is a folder of linked Markdown pages, properties and supporting files. Use it for reusable firm knowledge, clients, matters and processes. It is separate from a project chat, connected storage and the LegalMemory search service. This page applies when **Wiki** is available in navigation.

## Create or open a wiki

Open **Wiki > Add wiki > Create**, enter a name and choose **Personal** or **Team wiki**. Under **Starter structure**, select **Law firm knowledge** for clients, matters, knowledge, processes, templates and sources; **Legal Research** for legal findings organized by jurisdiction and area of law; or **Minimal wiki** for an adaptable starting point. Then choose **Create**. You can also join a shared wiki or use **Local folder options** to choose its folder. An existing wiki keeps its own conventions.

Open a wiki chat and ask, "Help me set up this wiki for our firm." Identify the particular connected source if you want the assistant to read it. Creating the wiki does not automatically import all connected documents. Review the resulting structure and source references before relying on it.

Wiki chats can search, list and read pages with Sandbox off. Running shell commands in a wiki chat requires protected execution: use the chat's **Sandbox** menu to enable it when a command is necessary. The option to run commands directly on your computer with Sandbox off applies to project chats. For questions about wiki contents, the assistant can use wiki and file-reading tools without enabling Sandbox.

## Your legal research knowledge base

For a legal research question, the agent first searches this wiki and reads relevant findings and saved sources. When they answer the question for the relevant jurisdiction and date, it reuses them instead of repeating the research. It searches external sources for missing information, conflicts or changes that need checking, then updates the existing page with new findings. Ask for fresh research when you want the sources checked again.

When you open this release with your local LegalWork server connected, LegalWork automatically creates a personal wiki named **Legal Research**, or **Rechtliche Recherche** when the app uses German. This applies to existing users and new installations, even if you have not connected a research database. Find it under **Wiki**. It starts without research findings and is not shared automatically.

To create another research wiki, choose **Add wiki > Create > Starter structure > Legal Research** (or **Rechtliche Recherche** in German). Give it your preferred name and choose **Create**. This uses the same research structure and legal-only filing guidance, with your app language and the country saved during research setup. Your existing research wiki is preserved. If you have not selected a country, the wiki starts with the general research indexes; jurisdiction folders can be added as you file findings.

The overview links to **By area of law**, **Jurisdictions**, **International law** and **Comparative research** (with German labels in a German wiki). The country selected during research onboarding supplies your initial jurisdiction; EU countries also get an EU law section. UK setup distinguishes England and Wales, Scotland and Northern Ireland. US setup includes federal law; state sections appear as you save relevant findings. Your country helps prepare navigation, but does not determine which law applies to a research question.

Findings are organized by **jurisdiction > area of law > specific legal issue**. The shared area catalogue covers contracts, corporate, employment, competition, intellectual property, privacy/technology, finance, tax, insolvency, property, public law, sector regulation, criminal, family, immigration, procedure and international law. One page can have several area or jurisdiction tags. **By area of law** and the jurisdiction pages automatically list the saved findings, so related knowledge appears in both places without copied pages. Select an area or jurisdiction to narrow the list. Earlier findings without classification appear under **Not classified** in the overall indexes.

Each finding records its legal question, conclusion, territorial scope, sources, exceptions and related knowledge. **Law as of** identifies the date of the law being analysed; **Last researched** records when the research was performed. Neither an ordinary edit nor saving a page verifies that its legal conclusions are still current. Comparisons link to the relevant jurisdiction pages.

This wiki is for substantive legal knowledge only: legal questions, legislation, case law, interpretation, exceptions and conflicting authorities, with their sources and limits. Browser instructions, workflows, login problems, process notes and task logs do not belong here. Website troubleshooting stays in each database skill's separate [experience log](integrations.md#learning-from-research-website-problems).

Legal research automatically reads and downloads the relevant primary judgments, legislation or other available original documents, then prepares a source-backed wiki entry. You do not need to ask separately for source downloads or a wiki draft. The assistant checks existing knowledge first and respects a request not to save. If a primary document is unavailable, the page retains its citation and link and identifies what could not be obtained.

The automatically generated Legal Research wiki saves project contributions in the background by default. Turn on **Require human approval from agents** in its **Settings > Agent access** if you want to review each contribution first. Other wikis require approval by default. Review the proposal, its jurisdiction, legal areas, dates, source documents and destination. Choose **Save to wiki** to publish or **Dismiss** to leave the wiki unchanged. Missing research folders are created only on publication. Turn off **Require human approval from agents** in this wiki's **Settings > Agent access** to let project agents save the page and sources in the background. A chat inside the wiki can edit its own pages directly.

Your pages, edits, renamed wiki and access settings survive app restarts and language changes. Upgrading the earlier research wiki adds navigation and updates only untouched original starter instructions and the untouched home page. Custom pages, instructions and organization are preserved. A shared wiki is not automatically restructured. Deleting or removing the wiki does not make LegalWork recreate it automatically. Use **Recently deleted** to restore a deleted wiki. If initial setup fails, the app offers **Retry** while you continue working. A read-only or non-owner connection cannot create the personal wiki.

## Pages, properties and links

Use the file tree to create or open a page. Edit its text and the properties below the title. **Source** mode exposes the Markdown; the outline helps navigate a long page. Links such as `[[Page.md]]` connect pages, and backlinks show other pages pointing to the current one. The graph visualizes those relationships; links in properties also contribute.

You can also ask the agent to include supporting source files with a wiki draft, for example: “Prepare these findings for the wiki and attach the judgment PDF.” The file must first be downloaded into the current project. Open **Filing details**, which starts collapsed to keep the page in focus. It contains the destination, legal classification and **Source files**. In **Source files**, select a filename to open its immutable copy in a separate file viewer tab. The draft remains open, and the file viewer provides the normal reading and download controls. Use **Remove** to exclude a file. **Save to wiki** files the page and the remaining sources together; **Dismiss** leaves the wiki unchanged. Source links are added to the page and stay correct if you change its destination before saving. The draft keeps copies, so editing or deleting an original download does not change the files you are reviewing. To replace a source with a newer version, ask the agent to remove it from the draft and attach it again. Drafts support up to 20 document or image files and 100 MB in total. Saved sources live directly in the wiki’s `Sources` folder, without folders named after internal IDs. Identical files are reused; different files with the same name receive a numbered suffix without overwriting existing documents. Legal research attachments must support legal knowledge, such as judgments or legislation; they are not a place for client records or process logs.

Imports copy files into the selected folder. PDFs, Office documents and media open in the normal viewers. Moving or renaming a page updates open tabs but does not rewrite every authored link, so check important references afterward. History and Trash can restore local saved versions; they are not a shared audit log or a replacement for a backup.

## Use knowledge from a project

In a project, use **+ > Wiki page…** to open an accessible page beside chat. That project view is read-only and links back to the wiki for editing. Project agents can search/read the wikis available to the project; a page's text does not grant access to other wikis or storage.

To contribute outside legal research, ask the assistant to suggest a specific useful update from the project. A scheduled wiki review can also prepare contributions through [Scheduled tasks](scheduled-tasks.md). Each destination wiki controls whether these contributions need review.

### Control agent approval

1. Open **Wiki**, then **All wikis**.
2. Choose **Settings** beside the wiki, then the **Agent access** tab.
3. Leave **Require human approval from agents** on to review project contributions before they are saved. This is the default for other existing and new wikis; the automatically generated Legal Research wiki defaults to off.
4. Turn it off to allow agents in other projects to save pages and source files in the background, then choose **Save**. No review tab opens for a background save.

This setting does not give a project access to a wiki, change sharing permissions or permit deleting pages. **Project access** still controls which projects may use the wiki, and read-only permissions still apply. Chats inside the wiki can edit directly. Changing this setting affects the next agent contribution or revision; it does not automatically publish existing pending drafts. Human edits to a draft remain pending until **Save to wiki**.

## Share and recover

Wiki settings can share with the firm or selected members when the firm's service supports independent wiki sharing. Only the owner changes access. Members join into a local folder. Saved changes sync with revision checks; overlapping edits retain a conflict copy. Signing out or losing access stops shared access. Stopping sharing leaves the owner's local folder intact.

Joining or updating a shared wiki downloads several files at once. Each file is verified before it is saved, and edits you make while downloads are running are preserved.

Use [Dashboards and reports](dashboards.md) for views of wiki properties. Source pages remain the place to correct underlying facts.
