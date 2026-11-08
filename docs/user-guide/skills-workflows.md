# Skills and workflows

Open in LegalWork: [Workflows](legalwork://app/workflows), [Skills](legalwork://app/settings/workflows/skills).

## Choose the right reusable resource

A **workflow** is a saved set of instructions and supporting files for work you repeat. For example, an NDA-review workflow can describe the firm's preferred positions, require clause citations and use an attached playbook. Each run applies those instructions to the documents and facts you provide. The workflow is the reusable procedure; the chat and its output are one execution of it.

A **skill** supplies instructions or a specialized capability the assistant can load when relevant. A **connection** gives the assistant access to a service. A **task** tracks a particular piece of work, while a **scheduled task** decides when the assistant should run. Creating a workflow does not automatically schedule it or connect it to client documents.

Open **Workflows** in the main sidebar. Use its **Workflows**, **Review prompts** and **Skills** tabs. Skills retain their search, import, creation, editing and team-sharing controls. Connections are managed under **Settings > Integrations**. Older links to Integrations > Skills open the Skills tab in Workflows.

## Create and edit

1. Open **Workflows**, choose the local library and create a workflow.
2. In **Details**, enter its name and description. Explain when it should be used, for example: "Review an incoming NDA against our mutual NDA playbook."
3. In **Instructions**, describe the inputs, steps, evidence requirements and output. A useful sequence is: read the attached agreement and playbook, identify deviations, cite clauses, and save an issues list. State what the assistant should ask when facts are missing.
4. In **Files**, attach reusable templates, playbooks and examples. Keep matter-specific agreements in the project or run's inputs unless deliberately making them reusable.
5. Select **Create** or **Save**. Resolve validation errors and the unsaved-changes prompt before leaving. Test the workflow on a representative document and inspect the result.

Opening a saved workflow, moving the cursor, or switching between **Rich text**, **Source mode** and **Diff mode** keeps its **Saved** status. Editing the instructions or details marks it as **Unsaved changes**. Select **Save** to store those edits.

Updating an existing project skill keeps it in its current library location, including a visible `Skills` folder in the connected document folder. New project skills use the local hidden library. Reusable corrections can extend an existing skill from either project location.

Older libraries offer **Assistant workflow** and **Tabular workflow** types. Newer libraries create ordinary workflows and provide **Review prompts** separately for reusable question sets. Existing tabular workflows can remain editable, but the native review implementation uses saved reviews rather than generating a standalone HTML grid. Follow the controls actually present in your library.

Attach the firm's templates, playbooks and examples as workflow resources. Resource files can be opened and edited in their supported editor; saving an edited resource updates the library copy. Generating a workflow from templates is available through the template generation action. Inspect the generated instructions before treating them as a firm standard.

You can also ask the assistant to create or save a skill/workflow. The `legalwork_skill_create` tool adds it to the shared library and can attach resource files. `legalwork_skill_list` checks existing entries. Writing a loose `SKILL.md` into an arbitrary folder does not by itself add it to the library shown in the app. Accept the app's reload prompt when required for the engine to see updated skills or tools.

## Run a workflow

Select a workflow and the documents/folder to use, or start it from a task's **Start workflow** action. Explain the intended result and any matter-specific constraints. Templates and instructions are inputs, so the assistant still needs the actual matter information. A skill that tells an agent how to do something does not itself grant credentials or access to folders.

For a first run, name the workflow and attach a concrete input: "Use our NDA review workflow on this agreement and save the issues list in this project." Check the requested input, completed output and source evidence before reusing the procedure widely. Editing a workflow changes its reusable instructions; it does not retroactively rewrite previous outputs.

For document-by-document tables, read [Tabular Review](reviews.md). The native page supports saved questions, model settings, progress and cited cells. Use `start-tabular-review` for native reviews and `author-review-prompts` for reusable question sets. Check missing, unreadable and uncertain evidence.

## Import, export and share

Use the library's supported import controls for a skill/workflow package or repository, and export a workflow as a ZIP when you need its reusable files. The **Team** view and sharing actions are available when the firm's connection and permissions allow them. Sharing a library item is different from sharing the source matter documents. Inspect imported instructions and resource files before running them against a matter.

Bundled skills, including `legalwork-help`, are installed centrally with the app and refreshed when the bundled version changes. New projects do not need their own copies. Save a separately named custom skill for firm-specific adaptations instead of relying on modifications to an app-managed copy.

Related: [Tasks](tasks-intake.md), [Scheduled tasks](scheduled-tasks.md), [Tabular Review](reviews.md), [Integrations](integrations.md), [Files](files-documents.md).
