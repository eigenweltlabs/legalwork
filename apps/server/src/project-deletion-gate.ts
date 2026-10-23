import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

// The reservation must include queued work and final writes after cancellation.
export type BackgroundTaskRunner = (run: () => Promise<void>) => Promise<void>;

const states = new WeakMap<ServerConfig, { deleting: boolean; requests: number }>();
function state(config: ServerConfig) {
  let value = states.get(config);
  if (!value) { value = { deleting: false, requests: 0 }; states.set(config, value); }
  return value;
}
const busy = () => new ApiError(409, "project_deletion_busy", "A project is being deleted or changed. Wait for it to finish and try again.");

// A deletion also changes incoming links in other projects. Exclude concurrent
// project mutations for the duration, including chat creation through the proxy.
export async function withProjectMutation<T>(config: ServerConfig, run: () => Promise<T>) {
  const value = state(config);
  if (value.deleting) throw busy();
  value.requests++;
  try { return await run(); } finally { value.requests--; }
}
export function assertNoProjectDeletion(config: ServerConfig) {
  if (state(config).deleting) throw busy();
}
export async function withProjectDeletion<T>(config: ServerConfig, run: () => Promise<T>) {
  const value = state(config);
  if (value.deleting || value.requests) throw busy();
  value.deleting = true;
  try { return await run(); } finally { value.deleting = false; }
}
