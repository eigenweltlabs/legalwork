import { t } from "@/i18n";

/**
 * Skills built into LegalWork, each with the commands that start it in chat
 * and an in-app viewer. The server seeds their files in every workspace via
 * core-skills (see apps/server/src/core-skills.ts + workspace-init.ts); the
 * Skills tab shows them so members know they are there.
 */
export type BuiltInSkill = {
  id: string;
  name: string;
  /** Translated on use, so it follows a change of language. */
  description: () => string;
  /** Slash commands that start it in chat. */
  commands: string[];
};

export const BUILT_IN_SKILLS: BuiltInSkill[] = [
  {
    id: "docx-redline",
    name: "DOCX Redline",
    description: () => t("skills.built_in_docx_description"),
    commands: ["/edit-docx"],
  },
  {
    id: "pdf-tools",
    name: "PDF Tools",
    description: () => t("skills.built_in_pdf_description"),
    commands: ["/open", "/annotate", "/fill-form", "/sign"],
  },
];
