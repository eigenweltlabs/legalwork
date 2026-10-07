type TaskText = { title: string; description: string };
type TaskDraftSnapshot = TaskText & {
  note: string;
  pendingWrites: number;
  savingNote: boolean;
  uploading: boolean;
};

/** Retained by its task scope, so switching rows does not throw away failed writes
 * or a note, and returning during a request cannot submit it a second time. */
export function createTaskDraft(initial: TaskText) {
  let baseline = initial;
  let snapshot: TaskDraftSnapshot = { ...initial, note: "", pendingWrites: 0, savingNote: false, uploading: false };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<TaskDraftSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => snapshot,
    isDirty: () => Boolean(snapshot.pendingWrites || snapshot.savingNote || snapshot.note.trim() || snapshot.title !== baseline.title || snapshot.description !== baseline.description),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setTitle: (title: string) => update({ title }),
    setDescription: (description: string) => update({ description }),
    setNote: (note: string) => update({ note }),
    discard: () => update({ ...baseline, note: "" }),
    reconcile: (server: TaskText) => {
      const title = snapshot.title === baseline.title ? server.title : snapshot.title;
      const description = snapshot.description === baseline.description ? server.description : snapshot.description;
      const changed = server.title !== baseline.title || server.description !== baseline.description;
      baseline = server;
      if (changed || title !== snapshot.title || description !== snapshot.description) update({ title, description });
    },
    write: async <T>(operation: () => Promise<T>): Promise<T> => {
      update({ pendingWrites: snapshot.pendingWrites + 1 });
      try { return await operation(); }
      finally { update({ pendingWrites: snapshot.pendingWrites - 1 }); }
    },
    upload: async (operation: () => Promise<unknown>) => {
      if (snapshot.uploading) return;
      update({ uploading: true, pendingWrites: snapshot.pendingWrites + 1 });
      try { await operation(); }
      finally { update({ uploading: false, pendingWrites: snapshot.pendingWrites - 1 }); }
    },
    submitNote: async (operation: (body: string) => Promise<boolean>) => {
      const submitted = snapshot.note;
      const body = submitted.trim();
      if (snapshot.savingNote || !body) return;
      update({ savingNote: true });
      try {
        if (await operation(body) && snapshot.note === submitted) update({ note: "" });
      } finally { update({ savingNote: false }); }
    },
  };
}

export type TaskDraft = ReturnType<typeof createTaskDraft>;
