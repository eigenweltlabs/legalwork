import type { SyncInbox } from "./sync-inbox.js";
import {
  BackOfficeSnapshotSchema,
  BackOfficeSyncPageSchema,
  type BackOfficeSnapshot,
  type BackOfficeRecord,
} from "./schema.js";
import { ApiError } from "../errors.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import type { ServerConfig } from "../types.js";
import { requireBackOfficePrincipal } from "./accounts.js";

export type DirectoryPosition = { access: string; cursor: number };
type PageResult = {
  snapshot: BackOfficeSnapshot;
  position?: DirectoryPosition;
  incremental: boolean;
  more: boolean;
};
/** Only the first page can submit operations. Keep the previous position until
 * every page is authorized, validated and ready to commit to SQLite together. */
export async function pullDirectory(
  config: ServerConfig,
  principal: string,
  position: DirectoryPosition | null,
  changes: unknown[],
  inbox: SyncInbox,
  translate: (record: BackOfficeRecord) => void,
  onIncompleteReset: () => void,
): Promise<PageResult> {
  let access = position?.access ?? null,
    since = position?.cursor ?? 0,
    through: number | undefined,
    after: string | undefined;
  let full = !position,
    reauthorizing = false,
    first = true,
    resets = 0;
  let accepted: string[] = [],
    conflicts: BackOfficeSnapshot["conflicts"] = [];
  try {
    for (;;) {
      let raw: unknown;
      for (let attempts = 0; ; attempts++) {
        await ensureFreshPlatformToken(config);
        const client = requireIntakeClient(
          await requireBackOfficePrincipal(config, principal),
        );
        try {
          raw = await intakeRequest(client, "POST", "/api/back-office", {
            protocol: 1,
            cursor: since,
            changes: first ? changes : [],
            page: { access, through, after },
          });
          break;
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.status !== 429 ||
            attempts >= 2
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
      }
      await requireBackOfficePrincipal(config, principal);
      if (!raw || typeof raw !== "object" || !("page" in raw)) {
        if (!first)
          throw new Error(
            "The sync protocol changed while downloading a directory.",
          );
        return {
          snapshot: BackOfficeSnapshotSchema.parse(raw),
          incremental: false,
          more: false,
        };
      }
      const page = BackOfficeSyncPageSchema.parse(raw);
      if (first) {
        accepted = page.accepted;
        conflicts = page.conflicts;
      }
      if (page.page.reset) {
        reauthorizing ||= Boolean(position);
        full = true;
        since = 0;
        after = undefined;
        inbox.clear();
        if (++resets > 3)
          throw new ApiError(
            409,
            "back_office_page_reset",
            "Directory access is updating.",
          );
      } else if (
        page.page.access !== access ||
        (through !== undefined && page.cursor !== through) ||
        page.cursor < since
      ) {
        throw new Error(
          "The sync page does not match the requested directory position.",
        );
      }
      inbox.add(page.records, translate);
      if (!page.page.next) {
        return {
          snapshot: {
            ...page,
            accepted,
            conflicts,
            records: [],
          },
          position: { access: page.page.access, cursor: page.cursor },
          incremental: !full,
          more: page.page.latest > page.cursor,
        };
      }
      if (after && page.page.next <= after)
        throw new Error("The sync page did not advance.");
      after = page.page.next;
      through = page.cursor;
      access = page.page.access;
      first = false;
    }
  } catch (error) {
    // A failed transfer must not leave a known revoked projection readable.
    if (reauthorizing) onIncompleteReset();
    throw error;
  }
}
