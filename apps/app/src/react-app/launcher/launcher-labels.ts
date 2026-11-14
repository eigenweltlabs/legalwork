import type en from "@/i18n/locales/en";
import type { AssistantSubmissionState, LauncherActionInput, LauncherFileSourceKind, LauncherSearchKind } from "@legalwork/types/launcher";
import type { AppActionId } from "./action-catalog";

export type TranslationKey = keyof typeof en;

export const categoryKeys = {
  files: "launcher.kind.files",
  projects: "launcher.kind.projects",
  chats: "launcher.kind.chats",
  tasks: "launcher.kind.tasks",
  recordings: "launcher.kind.recordings",
} satisfies Record<LauncherSearchKind, TranslationKey>;

export const appActionKeys = {
  "app.new-conversation": "launcher.action.new-conversation",
  "app.resume": "launcher.action.resume",
  "app.search-files": "launcher.action.search-files",
  "app.search-projects": "launcher.action.search-projects",
  "app.search-chats": "launcher.action.search-chats",
  "app.search-tasks": "launcher.action.search-tasks",
  "app.search-recordings": "launcher.action.search-recordings",
  "app.ask": "launcher.action.ask",
  "app.speak": "launcher.action.speak",
  "app.dictate": "launcher.action.dictate",
  "app.record": "launcher.action.record",
  "app.capture-region": "launcher.action.capture-region",
  "app.capture-window": "launcher.action.capture-window",
  "app.add-selection": "launcher.action.add-selection",
  "app.paste-clipboard": "launcher.action.paste-clipboard",
  "app.attach-file": "launcher.action.attach-file",
  "app.show-work": "launcher.action.show-work",
  "app.open-home": "launcher.action.open-home",
  "app.open-settings": "launcher.action.open-settings",
  "app.new-project": "launcher.action.new-project",
} satisfies Record<AppActionId, TranslationKey>;

export const inputKeys = {
  selection: "launcher.input.selection",
  files: "launcher.input.files",
  clipboard: "launcher.input.clipboard",
  arguments: "launcher.input.arguments",
} satisfies Record<LauncherActionInput, TranslationKey>;

export const sourceKeys = {
  project: "launcher.typed.source_project",
  wiki: "launcher.typed.source_wiki",
  folder: "launcher.typed.source_folder",
} satisfies Record<LauncherFileSourceKind, TranslationKey>;

export const submissionKeys = {
  sending: "launcher.submission.sending",
  accepted: "launcher.submission.accepted",
  running: "launcher.submission.running",
  completed: "launcher.submission.completed",
  failed: "launcher.submission.failed",
  unconfirmed: "launcher.submission.unconfirmed",
} satisfies Record<AssistantSubmissionState, TranslationKey>;
