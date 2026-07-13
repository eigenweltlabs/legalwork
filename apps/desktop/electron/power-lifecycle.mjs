/**
 * Background power lifecycle for the recorder and system-wide dictation.
 *
 * Two concerns, both injected with Electron modules so tests run without
 * Electron:
 *
 *  - PowerSessions: a refcounted wrapper around powerSaveBlocker. Held only
 *    while real work is in flight (an active recording, a file import, the
 *    dictation transcribe+paste tail) — never while idle-listening for the
 *    hotkey. 'prevent-app-suspension' maps to kIOPMAssertionTypeNoIdleSleep
 *    on macOS (also opts the process out of App Nap) and to an execution
 *    power request on Windows (keeps Modern Standby's Desktop Activity
 *    Moderator from freezing the process mid-recording).
 *
 *  - PowerLifecycle: powerMonitor sequencing. Suspend/lock must stop work
 *    immediately; resume work (helper re-spawn, model re-warm) runs after a
 *    settle delay because audio drivers and input devices are not ready at
 *    the instant of wake. A suspend during the settle window cancels the
 *    pending resume work.
 */

const RESUME_SETTLE_MS = 3_000;

export class PowerSessions {
  /**
   * @param {{ powerSaveBlocker: {
   *   start: (type: string) => number,
   *   stop: (id: number) => void,
   *   isStarted: (id: number) => boolean,
   * } }} options
   */
  constructor(options) {
    this.powerSaveBlocker = options.powerSaveBlocker;
    /** @type {Map<string, number>} */
    this.sessions = new Map();
    /** @type {number | null} */
    this.blockerId = null;
  }

  acquire(key) {
    this.sessions.set(key, (this.sessions.get(key) ?? 0) + 1);
    if (this.blockerId === null || !this.powerSaveBlocker.isStarted(this.blockerId)) {
      try {
        this.blockerId = this.powerSaveBlocker.start("prevent-app-suspension");
      } catch {
        this.blockerId = null;
      }
    }
  }

  release(key) {
    const count = this.sessions.get(key) ?? 0;
    if (count <= 1) this.sessions.delete(key);
    else this.sessions.set(key, count - 1);
    if (this.sessions.size === 0) this.stopBlocker();
  }

  releaseAll() {
    this.sessions.clear();
    this.stopBlocker();
  }

  stopBlocker() {
    if (this.blockerId === null) return;
    try {
      if (this.powerSaveBlocker.isStarted(this.blockerId)) {
        this.powerSaveBlocker.stop(this.blockerId);
      }
    } catch {
      // Releasing a blocker the OS already dropped must not throw mid-stop.
    }
    this.blockerId = null;
  }

  isActive() {
    return this.sessions.size > 0;
  }
}

export class PowerLifecycle {
  /**
   * @param {{
   *   powerMonitor: { on: (event: string, listener: () => void) => unknown, off?: (event: string, listener: () => void) => unknown },
   *   settleMs?: number,
   *   onSuspend?: () => void,
   *   onResume?: () => void | Promise<void>,
   *   onLockScreen?: () => void,
   *   onUnlockScreen?: () => void | Promise<void>,
   * }} options
   */
  constructor(options) {
    this.powerMonitor = options.powerMonitor;
    this.settleMs = options.settleMs ?? RESUME_SETTLE_MS;
    this.onSuspend = options.onSuspend ?? (() => {});
    this.onResume = options.onResume ?? (() => {});
    this.onLockScreen = options.onLockScreen ?? (() => {});
    this.onUnlockScreen = options.onUnlockScreen ?? (() => {});
    this.settleTimer = null;
    this.listeners = null;
  }

  start() {
    if (this.listeners) return;
    this.listeners = {
      suspend: () => this.handleSuspend(),
      resume: () => this.handleResume(),
      "lock-screen": () => this.onLockScreen(),
      "unlock-screen": () => this.handleUnlock(),
    };
    for (const [event, listener] of Object.entries(this.listeners)) {
      try {
        this.powerMonitor.on(event, listener);
      } catch {
        // lock-screen/unlock-screen exist on macOS + Windows only.
      }
    }
  }

  handleSuspend() {
    // Sleeping again while the previous resume was still settling: the
    // deferred re-warm would run against devices that are gone.
    this.clearSettleTimer();
    this.onSuspend();
  }

  handleResume() {
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void Promise.resolve(this.onResume()).catch(() => {});
    }, this.settleMs);
  }

  handleUnlock() {
    // Unlock without a suspend (plain Win+L / Ctrl+Cmd+Q) still passes the
    // secure desktop, which is where key-up events go missing — give the
    // helpers the same health check as a wake, but without the settle delay:
    // input devices never went away.
    if (this.settleTimer) return; // a resume settle is already pending
    void Promise.resolve(this.onUnlockScreen()).catch(() => {});
  }

  clearSettleTimer() {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  dispose() {
    this.clearSettleTimer();
    if (!this.listeners) return;
    for (const [event, listener] of Object.entries(this.listeners)) {
      try {
        this.powerMonitor.off?.(event, listener);
      } catch {
        // shutting down
      }
    }
    this.listeners = null;
  }
}
