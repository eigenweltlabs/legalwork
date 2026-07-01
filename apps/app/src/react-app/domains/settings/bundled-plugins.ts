/**
 * Plugins bundled into the app. A plugin is a capability that combines a
 * skill, an agent, and a command (and sometimes a connector) into one unit.
 *
 * These ship pre-installed in every workspace — the server seeds their files
 * via core-skills (see apps/server/src/core-skills.ts + workspace-init.ts), so
 * they're ready to use in chat. The Plugins tab surfaces them for discovery and
 * shows the slash command that launches each one.
 */
export type BundledPlugin = {
  id: string;
  name: string;
  description: string;
  /** Slash command that launches the plugin in chat. */
  command: string;
  /** Human-readable list of what the plugin bundles. */
  components: string[];
};

export const BUNDLED_PLUGINS: BundledPlugin[] = [
  {
    id: "tabular-review",
    name: "Tabular Review",
    description:
      "Firm-owned document review grid — extract structured, source-cited columns across many documents into an interactive table. The open-model answer to Harvey/Legora review grids.",
    command: "/review-docs",
    components: [
      "tabular-review skill",
      "document-extractor agent",
      "/review-docs command",
      "PDF.js viewer artifact",
    ],
  },
  {
    id: "docx-redline",
    name: "DOCX Redline",
    description:
      "Read and edit Word documents in-app — tracked-change redlines and comments through a headless OOXML engine, paired with a real .docx viewer.",
    command: "/edit-docx",
    components: [
      "docx-edit skill",
      "docx-redliner agent",
      "/edit-docx command",
      "in-app .docx editor",
    ],
  },
  {
    id: "pdf-tools",
    name: "PDF Tools",
    description:
      "Act on PDFs from chat — open them in the viewer, add sticky notes and highlights, fill form fields, and stamp signatures, always as a new reviewable copy.",
    command: "/annotate",
    components: [
      "pdf-tools skill",
      "/open, /annotate, /fill-form, /sign commands",
      "in-app PDF viewer",
    ],
  },
];
