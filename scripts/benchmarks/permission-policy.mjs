// Controller-only test policy. This never changes a product permission rule.
import { posix } from "node:path";

export function externalDirectoryDecision(request, { ownedSessionIDs, taskDirectory }) {
  const hold = reason => ({ decision: "hold", reason });
  if (!ownedSessionIDs.includes(request.sessionID)) return hold("unowned-session");
  if (!request.id || !(request.source?.messageID && request.source?.id || request.tool?.messageID && request.tool?.callID)) return hold("unattributed-request-source");
  if ((request.action ?? request.permission) !== "external_directory") return hold("unexpected-permission-action");
  const resources = request.resources ?? request.patterns;
  if (!Array.isArray(resources) || !resources.length || !posix.isAbsolute(taskDirectory)) return hold("unknown-directory-scope");
  const directories = [];
  for (const resource of resources) {
    if (typeof resource !== "string" || !resource.startsWith("/") || !resource.endsWith("/*") || /[\u0000\\?\[\]{}]/.test(resource) || resource.slice(0, -2).includes("*")) return hold("unknown-directory-scope");
    directories.push(posix.resolve(resource.slice(0, -1)));
  }
  const root = posix.resolve(taskDirectory);
  if (!directories.some(directory => directory !== root && !directory.startsWith(`${root}/`))) return hold("inside-task-folder-is-not-an-automatic-grant");
  return { decision: "reject", reason: "declared-test-policy-outside-task-folder", directories, taskDirectory: root, permissionRequestID: request.id, sessionID: request.sessionID };
}

export function permissionReplyEvent(event) {
  const value = event.payload ?? event;
  if (value.type !== "permission.replied") return null;
  const data = value.data ?? value.properties;
  if (!data?.sessionID || !data.requestID || !["once", "always", "reject"].includes(data.reply)) throw new Error("Malformed permission reply event; do not infer a decision");
  return { sessionID: data.sessionID, requestID: data.requestID, reply: data.reply, eventID: value.id ?? null, rawEvent: event };
}

export function exactRejectedReply(replies, request) {
  const matches = replies.filter(reply => reply.sessionID === request.sessionID && reply.requestID === request.id);
  if (matches.some(reply => reply.reply !== "reject") || matches.length > 1) throw new Error("Permission response was not one exact UI rejection");
  return matches[0] ?? null;
}

export function visibleDenyTarget(tsv, { minimumConfidence, width, height, scale = 1 }) {
  if (!(minimumConfidence >= 0 && minimumConfidence <= 100) || !(width > 0 && height > 0) || !(scale >= 1 && Number.isFinite(scale))) throw new Error("Explicit visual safety settings required");
  const rows = tsv.trim().split(/\r?\n/);
  const headers = rows.shift().split("\t");
  const words = rows.map(line => Object.fromEntries(line.split("\t").map((value, index) => [headers[index], value])));
  const candidates = words.filter(row => row.text?.trim() === "Deny");
  if (candidates.length !== 1) throw new Error("Exactly one visible Deny label is required; ambiguous UI is held");
  const row = candidates[0];
  const target = { x: (Number(row.left) + Number(row.width) / 2) / scale, y: (Number(row.top) + Number(row.height) / 2) / scale, confidence: Number(row.conf), label: row.text.trim(), ocrScale: scale, rectangle: { left: Number(row.left) / scale, top: Number(row.top) / scale, width: Number(row.width) / scale, height: Number(row.height) / scale } };
  if (!Number.isFinite(target.confidence) || target.confidence < minimumConfidence || !(target.rectangle.width > 0 && target.rectangle.height > 0) || !(target.x > 0 && target.x < width && target.y > 0 && target.y < height)) throw new Error("Uncertain visual Deny target; no click is permitted");
  return target;
}
