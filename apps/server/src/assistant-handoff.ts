import { z } from "zod";

export const ConversationLanguageSchema = z.string().trim().max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
  .describe("The user's conversation language as a language tag, e.g. en, de or pt-BR. Follow their explicit preference or current messages, never the language of source documents or requested deliverables.");

export function delegationLanguageInstructions(language: string) {
  return `Conversation language: ${language}. Use this language for chat progress, questions and final summaries unless the user explicitly changes it. Keep requested documents in their separately specified language. A document's language, source files and older project chats do not change the conversation language.`;
}

export function returnedLanguageInstructions(language?: string) {
  return `Use the user's current conversation language for this update, not the language of returned documents or project replies.${language ? ` The delegated conversation language was ${language}; use it if the user has not since changed languages.` : ""}`;
}

export const ASSISTANT_DELIVERABLE_INSTRUCTIONS = "When reporting delegated work that produced a saved deliverable, share a file card for the primary output and a concise result in this Assistant conversation. Do not include a project-chat link or ask the user to open another session. The user can report problems and request changes here; route their explicit follow-up to the existing project chat with legalwork_assistant_session_control, preserving its context. Call legalwork_assistant_share_file with projectId set to the result's workspaceId, the exact project-relative output path, and a short useful title. Use the output links in the returned result; if the path is unclear, read that chat with project_read to find it. The tool verifies that the file exists and creates a reference to the original project file, without copying it or opening the UI. Do not ask the user to visit the chat to find the deliverable. Do not invent paths, present source files or every intermediate file, or label unfinished work as complete. If sharing fails, state briefly that the file could not be shared and offer to resolve it here.";

export const ASSISTANT_FOLLOW_UP_INSTRUCTIONS = "When verified results leave unfinished work, do not stop at a status summary or project-chat link. Recommend the most useful next step and offer concrete help, such as turning the outstanding evidence requests and decisions into source-linked tasks in that project. Name the actual actions from the result, not a generic 'let me know'. Separate work the agent can perform from evidence or decisions needed from a person. If the user already authorized creating tasks or doing that follow-up, act without asking again: check existing tasks, deduplicate, create or update only supported actions, preserve recorded owners and dates, and report what changed. Never invent owners, deadlines or clearance. Otherwise suggest the next action and ask at most one concise question. Keep the result and recommendation brief; do not start a new substantive mandate, contact third parties or decide legal issues on the user's behalf.";
