import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { EmailDraftSchema, type EmailDraft } from "@legalwork/types/email-draft";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDraftAutosave } = await import("../src/components/chat/draft-autosave");
const { LegalworkServerError } = await import("../src/app/lib/legalwork-server");

const initial = EmailDraftSchema.parse({
  id: "b26d21f3-85ad-4c9f-a6ec-5249b2da280a", workspaceId: "project", revision: "e24143f1-b8b9-4a44-a497-8a3f2b3772b7", path: ".legalwork/email-drafts/draft.eml", updatedAt: 1,
  to: "client@example.com", subject: "Review", body: "Thanks for discussing this with the team.",
});

/** In-memory draft store with the server's revision check. */
function store() {
  let revision = 0;
  const saves: EmailDraft[] = [];
  const server: { draft: EmailDraft; saves: EmailDraft[]; hold: Promise<void> | null } = { draft: initial, saves, hold: null };
  const write = (next: EmailDraft) => { server.draft = { ...next, revision: `00000000-0000-4000-8000-${String(++revision).padStart(12, "0")}` }; return server.draft; };
  return Object.assign(server, {
    assistantEdit: (patch: Partial<EmailDraft>) => write({ ...server.draft, ...patch }),
    save: async (next: EmailDraft) => {
      if (server.hold) await server.hold;
      if (next.revision !== server.draft.revision) throw new LegalworkServerError(409, "draft_conflict", "This draft changed.");
      saves.push(next);
      return write(next);
    },
    load: async () => server.draft,
  });
}

let unmount = () => {};
afterEach(() => unmount());

async function mount(server: ReturnType<typeof store>) {
  const view: { current?: { draft: EmailDraft | null; baseline: EmailDraft | null; type: (patch: Partial<EmailDraft>) => void; autosave: ReturnType<typeof useDraftAutosave<EmailDraft>> } } = {};
  function Card() {
    const [draft, setDraft] = useState<EmailDraft | null>(initial), [baseline, setBaseline] = useState<EmailDraft | null>(initial);
    const autosave = useDraftAutosave(draft, baseline, { enabled: true, save: server.save, load: server.load, setDraft, setBaseline, setError: () => {} });
    view.current = { draft, baseline, autosave, type: patch => setDraft(previous => previous && { ...previous, ...patch }) };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Card />));
  unmount = () => act(() => root.unmount());
  const current = () => { if (!view.current) throw new Error("not mounted"); return view.current; };
  return current;
}

test("edits save on their own shortly after typing stops", async () => {
  const server = store(), card = await mount(server);
  await act(async () => card().type({ body: "Thanks for discussing this with the team!" }));
  expect(server.saves).toHaveLength(0);
  await act(() => new Promise(resolve => setTimeout(resolve, 1100)));
  expect(server.draft.body).toBe("Thanks for discussing this with the team!");
  expect(card().draft).toBe(card().baseline);
});

test("a save after the assistant changed the draft keeps the user's text and the assistant's other changes", async () => {
  const server = store(), card = await mount(server);
  server.assistantEdit({ subject: "Re: Review", body: "Thanks for discussing this." });
  await act(async () => card().type({ body: "Thanks for discussing this with the team!" }));
  await act(async () => { await card().autosave.flush(); });
  expect(server.draft).toMatchObject({ subject: "Re: Review", body: "Thanks for discussing this with the team!" });
  expect(card().draft).toBe(card().baseline);
  expect(card().autosave.replaced).toBe(true);
  await act(async () => card().autosave.takeAssistantVersion());
  await act(async () => { await card().autosave.flush(); });
  expect(server.draft.body).toBe("Thanks for discussing this.");
  expect(card().autosave.replaced).toBe(false);
});

test("typing while a save is running is kept and saved next", async () => {
  const server = store(), card = await mount(server);
  let release = () => {};
  server.hold = new Promise(resolve => { release = resolve; });
  await act(async () => card().type({ subject: "Review draft" }));
  let first: Promise<unknown> = Promise.resolve();
  await act(async () => { first = card().autosave.flush(); });
  await act(async () => card().type({ body: "Typed during the save." }));
  server.hold = null; release();
  await act(async () => { await first; });
  expect(server.draft).toMatchObject({ subject: "Review draft", body: initial.body });
  expect(card().draft).toMatchObject({ subject: "Review draft", body: "Typed during the save.", revision: server.draft.revision });
  await act(async () => { await card().autosave.flush(); });
  expect(server.draft).toMatchObject({ subject: "Review draft", body: "Typed during the save." });
});
