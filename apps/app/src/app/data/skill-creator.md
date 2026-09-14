---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create or update a skill that extends OpenCode with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill is a template + checklist for creating skills in a workspace.

## What is a skill?

A skill is a folder under `.opencode/skills/<skill-name>/` or `.claude/skills/<skill-name>/` anchored by `SKILL.md`.

## LegalWork behavior

- In LegalWork, create the skill with the `legalwork_skill_create` tool — never by writing a `SKILL.md` with `write`/`edit`/`apply_patch`. The tool installs it into the firm's shared library, which is what Settings > Skills and Settings > Workflows list and what the engine loads in every workspace; a hand-written file under `.opencode/skills/` stays a loose file the app never shows.
- Pass `kind: "workflow"` for a legal task the user runs on documents (drafting from a template, a review pass) so it lands in Settings > Workflows; leave it as a skill for knowledge the assistant should pick up on its own.
- Ship the firm's template with the workflow by passing `resourcePaths` — the files are copied into the skill's `resources/` folder and listed in its "Attached resources" section.
- Use `legalwork_skill_list` first to check whether something equivalent already exists.
- Installing through the tool lets LegalWork show the reload banner above the conversation so the user can activate the new skill immediately.

## Design goals

- Portable: safe to copy between machines
- Reconstructable: can recreate any required local state
- Self-building: can bootstrap its own config/state
- Credential-safe: no secrets committed; graceful first-time setup

## Recommended structure

```
.opencode/
  skills/
    my-skill/
      SKILL.md
      README.md
      templates/
      scripts/
```

## Trigger phrases (critical)

The description field is how Claude decides when to use your skill.
Include 2-3 specific phrases that should trigger it.

Bad example:
"Use when working with content"

Good examples:
"Use when user mentions 'content pipeline', 'add to content database', or 'schedule a post'"
"Triggers on: 'rotate PDF', 'flip PDF pages', 'change PDF orientation'"

Quick validation:
- Contains at least one quoted phrase
- Uses "when" or "triggers"
- Longer than ~50 characters

## Frontmatter template

```yaml
---
name: my-skill
description: |
  [What it does in one sentence]

  Triggers when user mentions:
  - "[specific phrase 1]"
  - "[specific phrase 2]"
  - "[specific phrase 3]"
---
```

## Authoring checklist

1. Start with a clear purpose statement: when to use it + what it outputs.
2. Specify inputs/outputs and any required permissions.
3. Include “Setup” steps if the skill needs local tooling.
4. Add examples: at least 2 realistic user prompts.
5. Keep it safe: avoid destructive defaults; ask for confirmation.
6. In LegalWork, finish by writing the final `SKILL.md` file to `.opencode/skills/<skill-name>/SKILL.md` so the reload banner can appear.
