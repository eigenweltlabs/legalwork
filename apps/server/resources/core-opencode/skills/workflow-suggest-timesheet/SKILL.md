---
name: workflow-suggest-timesheet
description: Reconstruct a private workday from enabled activity sources and scoped billing context.
---

# Suggest Timesheet

Group the supplied workday evidence first. Look across the whole day for work that belongs together, distinct work within one observed interval, and observations that do not support any entry. Keep ambiguous assignments and uncertain time open. Calendar appointments and foreground intervals can support a proposed time. An open background window or a background agent run gives context but does not establish human time. A task's completion, sent email or file save gives evidence of an action without its duration.

When the runner requests wording, use the billing language, action words, and terminology supplied for the validated scope. For DFT or MOD use the stable document ID and preferred billing title. Use a specific change description only when the evidence or the worker supplies it. Keep personal details out of billing narratives. Apply the worker’s requested changes to this draft. Use the supplied client or matter guidelines and confirmed descriptions for the same document.

In the Timekeeping project chat, use the timekeeping workday tool to read or regenerate the requested day’s suggestions. Apply a requested recurring preference through the normal project instructions or a project version of this skill. In the main Assistant, delegate to the Timekeeping chat when the user asks. The user reviews proposed entries in Time entries.
