export class VoiceVerifierClient {
  constructor(worker, model) {
    this.worker = worker;
    this.model = model;
    this.pending = null;
    this.stopped = false;
    worker.on("message", result => {
      if (result.error) this.pending?.reject(new Error(result.error));
      else this.pending?.resolve(result.result);
    });
    worker.on("exit", () => this.stop());
  }

  verify(audio, offsetMs, turns) {
    return this.request({ audio: new Uint8Array(audio), offsetMs, turns });
  }

  finish() { return this.request({ type: "finish" }); }

  async request(message) {
    if (this.stopped) throw new Error("Speaker voice matching is unavailable.");
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        timer = setTimeout(() => { reject(new Error("Speaker voice matching timed out.")); this.stop(); }, 30000);
        this.worker.postMessage({ model: this.model, ...message });
      });
    } finally {
      clearTimeout(timer);
      this.pending = null;
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pending?.reject(new Error("Speaker voice matching stopped."));
    this.worker.kill();
  }
}
