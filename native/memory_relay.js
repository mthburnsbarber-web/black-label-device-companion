// In-process deterministic harness. No socket or cloud access.
export class MemoryRelayClient {
  constructor(id) { this.id = id; this.connected = false; this.peer = null; this.dropVerifiedOnce = false; }
  status() { return { connected: this.connected }; }
  async start({ consent, onMessage }) { if (consent !== true) throw new Error('consent_required'); this.connected = true; this.onMessage = onMessage; }
  stop() { this.connected = false; }
  async send(message) {
    if (!this.connected || !this.peer?.connected) throw Object.assign(new Error('offline'), { code: 'offline' });
    if (this.dropVerifiedOnce && message.state === 'verified') { this.dropVerifiedOnce = false; return; }
    queueMicrotask(() => this.peer.onMessage({ authenticatedPeerId: this.id, message }));
  }
}

export function memoryRelayPair(firstId, secondId) {
  const first = new MemoryRelayClient(firstId), second = new MemoryRelayClient(secondId);
  first.peer = second; second.peer = first;
  return [first, second];
}
