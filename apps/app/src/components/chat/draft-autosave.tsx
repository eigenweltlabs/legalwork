import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";

const AUTOSAVE_DELAY_MS = 1000;
/** Fields the server owns. Local edits never overwrite them when rebasing. */
const serverFields = new Set(["id", "workspaceId", "revision", "path", "updatedAt", "artifactHash", "sequence", "startInstant", "endInstant", "connectorTarget", "delivery", "googleCalendar"]);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Puts the fields edited since `base` on top of `latest`. `overlap` lists the fields both sides changed; the local value wins. */
export function rebaseDraft<T extends object>(local: T, base: T, latest: T) {
  const draft = { ...latest };
  const overlap: Array<keyof T> = [];
  for (const key in local) {
    if (serverFields.has(key) || same(local[key], base[key])) continue;
    if (!same(latest[key], base[key]) && !same(latest[key], local[key])) overlap.push(key);
    draft[key] = local[key];
  }
  return { draft, overlap };
}

/**
 * Saves card edits shortly after typing stops. When the assistant saved a newer
 * version meanwhile, the edits are applied on top of it, and the user's text wins
 * where both changed the same field.
 */
export function useDraftAutosave<T extends { revision: string }>(draft: T | null, baseline: T | null, options: {
  enabled: boolean;
  save: (draft: T) => Promise<T>;
  load: () => Promise<T>;
  setDraft: Dispatch<SetStateAction<T | null>>;
  setBaseline: (draft: T) => void;
  setError: (message: string | null) => void;
  invalid?: (draft: T) => string | null;
}) {
  const [replaced, setReplaced] = useState<{ latest: T; keys: Array<keyof T> } | null>(null);
  const state = useRef({ draft, baseline }); state.current = { draft, baseline };
  const opts = useRef(options); opts.current = options;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invalid = draft && baseline && draft !== baseline ? options.invalid?.(draft) ?? null : null;

  const saveOnce = useCallback(async () => {
    const { draft: sent, baseline: base } = state.current;
    if (!sent || !base || sent === base) return sent;
    const { save, load, setDraft, setBaseline, setError } = opts.current;
    try {
      let saved: T;
      try { saved = await save(sent); }
      catch (problem) {
        if (!(problem instanceof LegalworkServerError && problem.code === "draft_conflict")) throw problem;
        const latest = await load();
        const rebased = rebaseDraft(sent, base, latest);
        saved = await save(rebased.draft);
        setReplaced(rebased.overlap.length ? { latest, keys: rebased.overlap } : null);
      }
      // Keep anything typed while the request was running.
      const now = state.current.draft;
      const next = !now || now === sent ? saved : rebaseDraft(now, sent, saved).draft;
      state.current = { draft: next, baseline: saved };
      setDraft(next); setBaseline(saved); setError(null);
      return saved;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not save the draft.");
      throw problem;
    }
  }, []);

  /** Saves pending edits now, after any save already running. Resolves to the saved draft. */
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const task = queue.current.then(saveOnce);
    queue.current = task.catch(() => undefined);
    return task;
  }, [saveOnce]);

  useEffect(() => {
    if (!options.enabled || !draft || draft === baseline || invalid) return;
    timer.current = setTimeout(() => void flush().catch(() => undefined), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer.current);
  }, [draft, baseline, invalid, options.enabled, flush]);
  // Save edits still waiting for the timer when the card leaves the chat.
  useEffect(() => () => {
    const { draft: pending, baseline: base } = state.current;
    if (pending && pending !== base && !opts.current.invalid?.(pending)) void flush().catch(() => undefined);
  }, [flush]);

  const takeAssistantVersion = () => {
    if (!replaced) return;
    opts.current.setDraft(current => {
      if (!current) return current;
      const next = { ...current };
      for (const key of replaced.keys) next[key] = replaced.latest[key];
      return next;
    });
    setReplaced(null);
  };
  return { invalid, flush, replaced: Boolean(replaced), takeAssistantVersion, keepMine: () => setReplaced(null) };
}

export function DraftReplacedNotice({ onUseAssistant, onKeepMine }: { onUseAssistant: () => void; onKeepMine: () => void }) {
  return <div role="status" className="mx-5 mb-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
    The assistant changed this draft while you were editing. Your edits were kept.
    <span className="mt-1 flex gap-1">
      <Button size="xs" variant="ghost" onClick={onUseAssistant}>Use assistant's version</Button>
      <Button size="xs" variant="ghost" onClick={onKeepMine}>Keep mine</Button>
    </span>
  </div>;
}
