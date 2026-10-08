import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Blocks, BookOpen, Bot, FilePenLine, FilePlus2, FolderSearch, Globe, KeyRound, ListChecks, MessageCircleQuestionMark, Search, SquareTerminal, Table2, Wrench } from "lucide-react";
import { isBashToolPart, isEditToolPart, isGlobToolPart, isGrepToolPart, isReadToolPart, isWriteToolPart } from "@/lib/build-in-tools";
import { getToolActivityLabel, isAppCapabilitiesToolPart, isToolPartInFlight, isToolPermissionDenied } from "@/lib/tool-activity";
import { t } from "@/i18n";
import { parseFilename, truncateText } from "./path";

type ToolPart = ToolUIPart | DynamicToolUIPart;

function nameOf(part: ToolPart) {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

function categoryOf(part: ToolPart) {
  if (isAppCapabilitiesToolPart(part)) return "read";
  const name = nameOf(part);
  if (name === "bash" || name === "exec_command") return "command";
  if (name === "task" || name === "task_status") return "agent";
  if (name === "question") return "question";
  if (name === "request_env_var" || name === "env_var_request") return "credentials";
  if (name === "skill") return "skill";
  if (name === "todowrite") return "plan";
  if (name === "webfetch") return "web";
  if (name === "legalwork_review_settings" || name === "legalwork_review_library") return "read";
  if (name === "legalwork_review_list" || name === "legalwork_review_files") return "browse";
  if (name === "legalwork_jev_corpus_question") return "search";
  if (/(?:^|[_-])(?:search|grep|glob|find)(?:$|[_-])/.test(name)) return "search";
  if (name === "websearch") return "search";
  if (/(?:^|[_-])(?:read|get|results|inspect)(?:$|[_-])/.test(name) || name === "lsp") return "read";
  if (/(?:^|[_-])(?:edit|patch|update|rename)(?:$|[_-])/.test(name)) return "edit";
  if (/(?:^|[_-])(?:write|create|save)(?:$|[_-])/.test(name)) return "write";
  if (name.startsWith("legalwork_review_")) return "review";
  if (/(?:^|[_-])(?:list|files|browse)(?:$|[_-])/.test(name)) return "browse";
  return "tool";
}

const icons = {
  command: SquareTerminal, read: BookOpen, edit: FilePenLine, write: FilePlus2,
  search: Search, web: Globe, skill: Blocks, plan: ListChecks, agent: Bot,
  question: MessageCircleQuestionMark, credentials: KeyRound, review: Table2,
  browse: FolderSearch, tool: Wrench,
};

function categoryLabel(category: ReturnType<typeof categoryOf>): string {
  return {
    command: t("tool_run.summary.command"),
    read: t("tool_run.summary.read"),
    edit: t("tool_run.summary.edit"),
    write: t("tool_run.summary.write"),
    search: t("tool_run.summary.search"),
    web: t("tool_run.summary.web"),
    skill: t("tool_run.summary.skill"),
    plan: t("tool_run.summary.plan"),
    agent: t("tool_run.summary.agent"),
    question: t("tool_run.summary.question"),
    credentials: t("tool_run.summary.credentials"),
    review: t("tool_run.summary.review"),
    browse: t("tool_run.summary.browse"),
    tool: t("tool_run.summary.tool"),
  }[category];
}

export function getToolIcon(part: ToolPart) {
  return icons[categoryOf(part)];
}

/** Compact history labels retain the useful target without exposing command bodies. */
export function getToolHistoryLabel(part: ToolPart): string {
  if (isToolPartInFlight(part)) return getToolActivityLabel(part);
  if (isToolPermissionDenied(part)) return t("tool_run.permission_denied");
  if (part.state === "output-error") return t("tool_run.action_failed");
  if (isAppCapabilitiesToolPart(part)) return t("tool_run.checked_app_capabilities");
  if (nameOf(part) === "legalwork_assistant_set_name") return t("assistant.name_saved");
  if (nameOf(part) === "legalwork_assistant_attention") return t("assistant.attention_checked");
  if (nameOf(part) === "legalwork_assistant_attention_present") return t("assistant.attention_presented");
  if (nameOf(part) === "legalwork_assistant_attention_answer") return t("assistant.attention_answered");
  if (nameOf(part) === "legalwork_assistant_follow_up") return t("assistant.attention_followed_up");
  if (isReadToolPart(part)) return t("tool_run.read_file", { file: parseFilename(part.input?.filePath) });
  if (isEditToolPart(part)) return t("tool_run.edited_file", { file: parseFilename(part.input?.filePath) });
  if (isWriteToolPart(part)) return t("tool_run.wrote_file", { file: parseFilename(part.input?.filePath) });
  if (isGrepToolPart(part) || isGlobToolPart(part)) {
    const pattern = part.input?.pattern?.trim();
    return pattern ? t("tool_run.searched_for", { pattern: truncateText(pattern, 44) }) : t("tool_run.summary.search");
  }
  if (isBashToolPart(part)) {
    const description = part.input?.description?.trim();
    return description ? truncateText(description, 80) : t("tool_run.ran_command");
  }
  if (nameOf(part) === "legalwork_jev_corpus_question") {
    const input = part.input;
    if (input && typeof input === "object" && "jobId" in input) {
      if ("evidencePath" in input && typeof input.evidencePath === "string") return t("tool_run.jev_evidence", { path: truncateText(input.evidencePath, 65) });
      return t("tool_run.jev_saved_results");
    }
    return t("tool_run.jev_search");
  }
  if (nameOf(part) === "legalwork_review_results") return t("tool_run.review_results");
  if (nameOf(part) === "legalwork_review_settings") return t("tool_run.review_settings");
  if (nameOf(part) === "legalwork_review_list") return t("tool_run.review_list");
  if (categoryOf(part) !== "tool") return categoryLabel(categoryOf(part));
  const name = nameOf(part).replace(/^(?:inapp_|legalwork_)/, "").replace(/[_-]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function getToolRunSummary(parts: ToolPart[]): string {
  if (parts.length === 1) return getToolHistoryLabel(parts[0]);
  return [...new Set(parts.map(categoryOf))].map(categoryLabel).join(" · ");
}
