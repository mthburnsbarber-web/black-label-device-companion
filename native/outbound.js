const fail = code => Object.assign(new Error(code), { code });

// Network is inert until start({consent:true}) is called with a paired device's
// credential and encryption providers. This module never generates keys.
export class OutboundCompanionClient {
  constructor({ deviceId, relayUrl, getAuthorization, seal, open, socketFactory = url => new WebSocket(url) }) {
    const url = new URL(relayUrl);
    if (url.protocol !== 'wss:' || url.username || url.password || !deviceId || !getAuthorization || !seal || !open) throw fail('invalid_configuration');
    this.deviceId = deviceId; this.relayUrl = url.toString(); this.getAuthorization = getAuthorization;
    this.seal = seal; this.open = open; this.socketFactory = socketFactory;
    this.socket = null; this.enabled = false; this.connected = false; this.onMessage = null;
  }
  status() { return { deviceId: this.deviceId, enabled: this.enabled, connected: this.connected, transport: 'outbound_wss' }; }
  async start({ consent, onMessage } = {}) {
    if (consent !== true) throw fail('consent_required');
    if (this.socket && this.connected) throw fail('already_started');
    if (this.socket) { this.socket.close(); this.socket = null; }
    const authorization = await this.getAuthorization(this.deviceId);
    if (typeof authorization !== 'string' || !authorization) throw fail('pairing_required');
    this.enabled = true; this.onMessage = onMessage || null;
    let socket;
    try { socket = this.socketFactory(this.relayUrl); } catch (cause) { this.enabled = false; throw cause; }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (!this.enabled) return;
      socket.send(JSON.stringify({ version: 1, type: 'authenticate', deviceId: this.deviceId, authorization }));
    });
    socket.addEventListener('message', async event => {
      if (!this.enabled) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'authenticated' && frame.deviceId === this.deviceId) { this.connected = true; return; }
        if (frame.type !== 'encrypted' || !this.connected) return;
        const decoded = await this.open(frame.payload);
        await this.onMessage?.(decoded);
      } catch { /* Caller can inspect connected state; never log payloads. */ }
    });
    socket.addEventListener('close', () => { if (this.socket === socket) { this.connected = false; this.socket = null; } });
    socket.addEventListener('error', () => { if (this.socket === socket) this.connected = false; });
  }
  async send(message) {
    if (!this.enabled || !this.connected || !this.socket) throw fail('offline');
    const payload = await this.seal(message);
    if (typeof payload !== 'string' || !payload) throw fail('encryption_failed');
    this.socket.send(JSON.stringify({ version: 1, type: 'encrypted', deviceId: this.deviceId, payload }));
  }
  stop() { this.enabled = false; this.connected = false; this.onMessage = null; this.socket?.close(); this.socket = null; }
}
