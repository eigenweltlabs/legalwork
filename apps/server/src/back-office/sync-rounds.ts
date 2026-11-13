/** An explicit request during an active round must observe a subsequent round. */
export class BackOfficeSyncRounds {
  private readonly running = new Map<
    string,
    { again: boolean; promise: Promise<void> }
  >();

  run(key: string, action: () => Promise<void>): Promise<void> {
    const current = this.running.get(key);
    if (current) {
      current.again = true;
      return current.promise;
    }
    const round = { again: false, promise: Promise.resolve() };
    this.running.set(key, round);
    round.promise = Promise.resolve().then(async () => {
      try {
        do {
          round.again = false;
          await action();
        } while (round.again);
      } finally {
        if (this.running.get(key) === round) this.running.delete(key);
      }
    });
    return round.promise;
  }
}
