/** macOS sender avatars require an INSendMessageIntent, which Electron does not expose. */
export class CommunicationNotifications {
  constructor({ load, onClick, logger = console, timeoutMs = 10_000 }) {
    this.load = load;
    this.onClick = onClick;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.native = null;
  }

  // null means the native path is unavailable and an ordinary notification should be used.
  async show(input) {
    try {
      if (!this.native) {
        this.native = this.load();
        this.native.initialize(event => {
          if (event.type === "click") { this.onClick(event.id); return; }
          const finish = this.pending.get(event.id);
          if (event.type === "show") finish?.(true);
          if (event.type === "failed") {
            this.logger.warn("[assistant-notification] Sender avatar unavailable:", event.error);
            finish?.(null);
          }
        });
      }
      return await new Promise(resolve => {
        const finish = result => { clearTimeout(timer); this.pending.delete(input.id); resolve(result); };
        const timer = setTimeout(() => {
          // Delivery can still finish later. Do not post a second notification on timeout.
          this.logger.warn("[assistant-notification] Native delivery confirmation timed out");
          finish(false);
        }, this.timeoutMs);
        this.pending.set(input.id, finish);
        try { this.native.send(input); }
        catch (error) { this.logger.warn("[assistant-notification] Native delivery failed:", error); finish(null); }
      });
    } catch (error) {
      this.logger.warn("[assistant-notification] Native sender avatars unavailable:", error);
      return null;
    }
  }
}
