export const BROWSER_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** One inactivity deadline per chat. Preview refreshes never count as activity. */
export function createBrowserIdleSessions(expire) {
  const sessions = new Map();
  let disposed = false;
  function session(id) {
    if (!sessions.has(id)) sessions.set(id, { active: false, busy: 0, revision: 0, timer: null });
    return sessions.get(id);
  }
  function touch(id) {
    if (!id || disposed) return;
    const current = session(id);
    clearTimeout(current.timer);
    current.timer = null;
    const revision = ++current.revision;
    if (current.active || current.busy) return;
    current.timer = setTimeout(() => {
      current.timer = null;
      expire(id, () => sessions.get(id) === current && current.revision === revision && !current.active && !current.busy);
    }, BROWSER_IDLE_TIMEOUT_MS);
    current.timer.unref?.();
  }
  return {
    touch,
    active(id, active) {
      if (!id || disposed) return;
      session(id).active = active;
      touch(id);
    },
    isActive: id => sessions.get(id)?.active ?? true,
    use(id) {
      if (!id || disposed) return () => {};
      const current = session(id);
      current.busy++;
      touch(id);
      return () => { current.busy--; touch(id); };
    },
    dispose() {
      disposed = true;
      for (const current of sessions.values()) clearTimeout(current.timer);
      sessions.clear();
    },
  };
}
