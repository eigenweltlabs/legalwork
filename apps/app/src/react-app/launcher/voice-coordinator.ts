/**
 * One microphone owner. Each capture has an explicit destination; opening
 * search or a panel never starts a second capture or changes where an ongoing
 * dictation goes. A different destination needs an explicit transition.
 */
export type VoiceDestination = "external" | "assistant" | "meeting";
export type VoiceOwner = { destination: VoiceDestination; ownerId: string; since: number; conversationId?: string; origin?: { app: string | null; window: string | null } };
export type VoiceDecision = { ok: true; owner: VoiceOwner } | { ok: false; reason: "busy"; active: VoiceOwner };

export class VoiceCoordinator {
  private active: VoiceOwner | null = null;
  private listeners = new Set<(owner: VoiceOwner | null) => void>();
  current() { return this.active; }
  subscribe(listener: (owner: VoiceOwner | null) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(this.active); }
  request(input: Omit<VoiceOwner, "since">, now = Date.now()): VoiceDecision {
    if (this.active && this.active.ownerId !== input.ownerId) return { ok: false, reason: "busy", active: this.active };
    this.active = { ...input, since: this.active?.ownerId === input.ownerId ? this.active.since : now };
    this.emit();
    return { ok: true, owner: this.active };
  }
  /** A mode change during capture is explicit: the previous owner releases first, keeping its recorded data. */
  transition(from: string, to: Omit<VoiceOwner, "since">, now = Date.now()): VoiceDecision {
    if (this.active && this.active.ownerId !== from) return { ok: false, reason: "busy", active: this.active };
    this.active = null;
    return this.request(to, now);
  }
  release(ownerId: string) {
    if (this.active?.ownerId !== ownerId) return false;
    this.active = null;
    this.emit();
    return true;
  }
}
export const voiceCoordinator = new VoiceCoordinator();
