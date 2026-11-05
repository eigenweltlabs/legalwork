---
name: libra-research
description: Research through the Libra by Wolters Kluwer agent chat at app.libratech.ai. Submit the legal question, wait for its answer with a bounded timeout, inspect its sources, and return findings. For login setup alone, use the existing secure login card directly.
---

# Research with Libra

Use this skill when the user selects Libra or the general legal-research skill chooses a saved Libra connection. Load legal-research if it is not already loaded, and use its source selection, vault, website experience and automatic source preservation and wiki contribution instructions. Saving a Libra login does not require loading either skill.

## Access

Start at https://app.libratech.ai/. Its observed sign-in flow redirects to https://auth.libratech.ai and asks for an email address first. Inspect the actual page and subsequent password step. Use the existing vault and fresh browser refs; never save or replay an Auth0 URL containing state. For setup, legalwork_browser_request_password with provider "libra" supplies the card directly. Continue MFA or institutional sign-in with the user when needed.

Libra is a Wolters Kluwer legal AI workspace. Available source collections depend on the account. Wolters Kluwer Online and other publisher collections can require add-ons; do not infer access from the provider name, purchase a subscription or enable a paid collection automatically. Use observed available sources and report coverage gaps.

## Delegate the research

First follow legal-research's wiki lookup and reuse instructions. If the saved findings answer the question, use them without starting another Libra run unless the user requests fresh Libra research. Otherwise send Libra the remaining gaps or required updates, with relevant source references, rather than repeating work already saved.

1. Open or reuse a Libra conversation for this task. Inspect the visible chat, input and research/source controls; never assume selectors or button labels. Use a new conversation for an unrelated question so prior matters do not contaminate the answer. For follow-ups, keep the existing task conversation.
2. Put the research question into Libra's agent chatbox. Include the jurisdiction, relevant date, necessary facts, requested depth, and required output: conclusions, exceptions, competing authorities and precise source citations with links. Use Wolters Kluwer sources when relevant and available. Submit only information the user authorized for this research; do not upload unrelated matter files or credentials.
3. Send once, then confirm that the user message appears in the conversation or that a run visibly starts. If the send call times out or the page reloads, inspect the conversation before doing anything else. Never resubmit merely because the tool response was lost. If submission remains ambiguous, report it and preserve the conversation.
4. Keep the tab ID and conversation URL in the current task context. They belong to this task, not the persistent experience log. Note the submission time and set a five-minute overall deadline, unless the user specified another limit.

## Wait and retrieve

Use the browser's observed progress indicators. With a visible running message, call browser.wait for that text to disappear (condition "textGone", text equal to the observed text, timeoutMs at most 30000), then inspect a fresh snapshot of the conversation. Each timeout is a checkpoint, not a failed research request: inspect for results or errors and continue only while it is still running and time remains. For the default five-minute budget, wait at most ten times and never beyond the overall deadline. If the user supplied another limit, adjust the maximum number of waits while keeping each wait at most 30 seconds. Do not reset the deadline after a refresh or a timeout. Give a short progress update when waiting takes more than a minute.

If the UI uses a different progress signal, inspect the available browser wait signature and use a supported condition that matches the actual page. Do not invent a completion label, treat an immediately satisfied load condition as a delay, or take repeated snapshots in a tight loop. If the tool cannot wait reliably on the observed UI, explain that limitation and preserve the conversation for a later check.

Read the answer only once it has finished generating: the running state has ended and the answer belongs to the submitted question. Partial streaming text, an empty chat or a vanished loading message alone do not establish completion. Stop early for an explicit error, access restriction, MFA or a question requiring user input. Do not restart the job automatically.

At the deadline, leave the conversation open and report that Libra has not finished within five minutes, with its conversation link when available. Label partial findings as incomplete. Do not claim there are no results or submit a duplicate prompt. On a later request to check again, reopen the same conversation and inspect it before starting another bounded wait.

For a completed answer, inspect its cited sources and relevant passages where accessible. Distinguish Libra's generated synthesis from the underlying authority; preserve jurisdiction, dates, citations, links and material uncertainty. Report inaccessible or unverified sources. Do not manufacture citations. Return a useful synthesis to the user rather than merely saying Libra has answered.

## Learn and file

Use legalwork_research_experience with name "legal-research" and the saved Libra connectionId and websiteUrl to read and update this site's persistent operational notes. Record observed problems and attempted fixes; mark a fix verified only after observed success. Keep those notes generic, with no prompts, legal findings, conversation URLs, credentials or client details. A timeout is unresolved unless a later observation establishes the outcome. These notes survive skill updates; do not edit the bundled skill file at runtime.

For useful legal findings, follow legal-research: download relevant primary source documents and contribute LEGAL KNOWLEDGE ONLY without a separate request to prepare a wiki entry. The destination wiki's approval setting determines whether the contribution waits for human Save or publishes in the background. Browser procedures and waiting/debugging notes never go into the wiki.

Provider evidence checked 2026-10-28: [official app entry](https://libratech.ai/), [source collections and add-ons](https://libratech.ai/product/legal-content), [Wolters Kluwer acquisition](https://www.wolterskluwer.com/en/news/wolters-kluwer-completes-acquisition-of-libra-technology-gmbh). Only the public sign-in flow was observed during implementation; authenticated chat controls must be inspected live.
