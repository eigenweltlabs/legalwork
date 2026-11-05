import { resolve } from "node:path";
import { z } from "zod";
import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { WorkspaceInfo } from "../types.js";
import type { SavedReview } from "./schema.js";
import { ReviewStore, serialized, within } from "./storage.js";
export type ReviewSession = Pick<SessionInfo, "id" | "location" | "time">;
export type ReviewSessionClient = {
  get: (id: string) => Promise<ReviewSession | null>;
  /** All pages, scoped to this workspace. */
  list: () => Promise<ReviewSession[]>;
  /** Complete saved history, including messages outside the current model context. */
  messages: (id: string, limit?: number) => Promise<SessionMessageInfo[]>;
  create: (title: string) => Promise<ReviewSession>;
  unarchive: (id: string) => Promise<unknown>;
};
const startedReview = z.object({
  type: z.literal("tool"), name: z.enum(["legalwork_review_create", "legalwork_review_start"]),
  state: z.object({ status: z.literal("completed"), content: z.array(z.unknown()), metadata: z.unknown().optional() }),
});
const outputSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), review: z.object({ id: z.string() }) });
/** Resolve old review cards once, then persist the link when the user opens it. */
export class ReviewSessions {
  private legacy = new Map<string, {
    expires: number;
    value: Promise<string | null>;
  }>();
  constructor(private client: (workspace: WorkspaceInfo) => ReviewSessionClient) { }
  private inProject(workspace: WorkspaceInfo, session: ReviewSession) {
    return !!session.location.directory && within(resolve(workspace.path), resolve(session.location.directory));
  }
  private async find(workspace: WorkspaceInfo, review: SavedReview, client: ReviewSessionClient) {
    if (review.sessionId) {
      const session = await client.get(review.sessionId);
      return session && this.inProject(workspace, session) ? session : null;
    }
    // Explicit null means a new review created in the UI. Only older files
    // without provenance need historical tool lookup; never match by title.
    if (review.sessionId === null)
      return null;
    const key = `${workspace.path}\0${review.id}`;
    let cached = this.legacy.get(key);
    if (!cached || cached.expires < Date.now()) {
      for (const [key, item] of this.legacy)
        if (item.expires < Date.now())
          this.legacy.delete(key);
      const value = this.findLegacy(workspace, review, client);
      cached = { value, expires: Date.now() + 5 * 60000 };
      this.legacy.set(key, cached);
      value.catch(() => this.legacy.delete(key));
    }
    const id = await cached.value;
    const session = id ? await client.get(id) : null;
    // The cached session may have moved since the provenance scan.
    return session && this.inProject(workspace, session) ? session : null;
  }
  private async findLegacy(workspace: WorkspaceInfo, review: SavedReview, client: ReviewSessionClient) {
    const sessions = (await client.list()).filter(session => this.inProject(workspace, session)
      && (!session.time?.created || session.time.created <= review.createdAt)
      && (!session.time?.updated || session.time.updated >= review.createdAt))
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
    for (const session of sessions) {
      for (const message of await client.messages(session.id)) {
        if (message.type !== "assistant")
          continue;
        for (const part of message.content) {
          const tool = startedReview.safeParse(part);
          if (!tool.success)
            continue;
          for (const item of tool.data.state.content) {
            const text = z.object({ type: z.literal("text"), text: z.string() }).safeParse(item);
            if (!text.success)
              continue;
            try {
              const output = outputSchema.safeParse(JSON.parse(text.data.text));
              if (output.success && output.data.workspaceId === workspace.id && output.data.review.id === review.id)
                return session.id;
            }
            catch { /* Non-JSON content and reminder text are not provenance. */ }
          }
        }
      }
    }
    return null;
  }
  async get(workspace: WorkspaceInfo, id: string) {
    const review = await new ReviewStore(workspace.path).read(id);
    // A UI-created review explicitly has no origin chat. Reading that saved
    // fact works offline and must not require an engine connection.
    if (review.sessionId === null) return { sessionId: null };
    const session = await this.find(workspace, review, this.client(workspace));
    return { sessionId: session?.id ?? null };
  }
  async open(workspace: WorkspaceInfo, id: string) {
    // A double click, another window, or a retried HTTP request reuses the chat.
    return serialized(`${workspace.path}\0${id}:discussion`, async () => {
      const store = new ReviewStore(workspace.path), review = await store.read(id), client = this.client(workspace);
      const existing = await this.find(workspace, review, client);
      const session = existing ?? await client.create(review.name);
      if (session.time?.archived)
        await client.unarchive(session.id);
      if (review.sessionId !== session.id)
        await store.update(id, current => {
          current.sessionId = session.id;
          current.sessionCreatedForReview = !existing;
        });
      const prefill = !existing || (!!review.sessionCreatedForReview && !(await client.messages(session.id, 1)).length);
      return { sessionId: session.id, prefill };
    });
  }
}
