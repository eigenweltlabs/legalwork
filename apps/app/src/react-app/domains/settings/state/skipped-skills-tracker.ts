type SkippedSkill = { path: string; reason: string };

export function createSkippedSkillsTracker() {
  const seenBySource = new Map<string, Set<string>>();

  return (source: string, skipped: SkippedSkill[]): SkippedSkill[] => {
    const previous = seenBySource.get(source);
    const current = new Set<string>();
    const newlySkipped: SkippedSkill[] = [];

    for (const item of skipped) {
      const key = JSON.stringify([item.path, item.reason]);
      if (!current.has(key) && !previous?.has(key)) newlySkipped.push(item);
      current.add(key);
    }

    if (current.size) seenBySource.set(source, current);
    else seenBySource.delete(source);
    return newlySkipped;
  };
}
