import { useSyncEventsLive } from "../kernel/sync-events";

/** Push updates replace frequent metadata polling; a slow reconciliation also covers external writers. */
export function useMetadataPolling(baseUrl: string | null | undefined, legacyInterval: number): number {
  const covered = useSyncEventsLive(state => state.live && state.metadata && state.baseUrl === baseUrl);
  return covered ? 60_000 : legacyInterval;
}
