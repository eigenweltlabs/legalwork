import { ApiError } from "./errors.js";

type ReactionMessage = {
  info: { id: string; role: string; parentID?: string };
  parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean; tool?: string }[];
};

/** Acknowledgement is only valid before any prose or other action in the user's turn. */
export function assistantReactionTarget(messages: ReactionMessage[], assistantMessageId: string) {
  const user = [...messages].reverse().find(message => message.info.role === "user");
  const caller = messages.find(message => message.info.id === assistantMessageId && message.info.role === "assistant");
  if (!user || !caller || caller.info.parentID !== user.info.id)
    throw new ApiError(409, "reaction_turn", "React only to the current user message.");
  const text = user.parts.filter(part => part.type === "text" && !part.synthetic && !part.ignored).map(part => part.text ?? "").join("\n").trim();
  if (!text || text.startsWith("[Scheduled task:")) throw new ApiError(409, "reaction_automated", "React to a person, not an automated task or notification.");
  const turn = messages.filter(message => message.info.role === "assistant" && message.info.parentID === user.info.id);
  const parts = turn.flatMap(message => message.parts);
  const tools = parts.filter(part => part.type === "tool");
  if (parts.some(part => part.type === "text" && part.text?.trim() && !part.synthetic && !part.ignored) || tools.length !== 1 || tools[0].tool !== "legalwork_assistant_react" || !caller.parts.includes(tools[0]))
    throw new ApiError(409, "reaction_too_late", "A reaction must be your first action. Continue normally without adding one now.");
  return user.info.id;
}
