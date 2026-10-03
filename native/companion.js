import { createHash, randomUUID } from 'node:crypto';
import { MAX_BYTES, MIME, validatePayload } from '../core.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const terminal = new Set(['verified', 'verification_failed', 'concurrent_change', 'permission_denied', 'expired', 'invalid_payload', 'ambiguous_after_restart']);

// The client must deliver {authenticatedPeerId,message} only after paired-key
// authentication and decryption. The in-memory test relay is NOT that provider.
export class NativeCompanion {
  constructor({ deviceId, clipboard, client, state, pairedDeviceIds = [], timeoutMs = 500, maxAttempts = 3, now = Date.now }) {
    this.deviceId = deviceId; this.clipboard = clipboard; this.client = client; this.state = state;
    this.paired = new Set(pairedDeviceIds); this.timeoutMs = timeoutMs; this.maxAttempts = maxAttempts; this.now = now;
    this.enabled = false; this.waiters = new Map(); this.queue = Promise.resolve();
  }
  status() { return { deviceId: this.deviceId, enabled: this.enabled, connected: this.client.status().connected, capabilities: ['clipboard_text'], pairedDeviceIds: [...this.paired] }; }
  async start({ consent } = {}) {
    if (consent !== true) throw fail('consent_required');
    if (this.enabled) throw fail('already_started');
    await this.state.load();
    this.clipboard.activate?.({ consent: true });
    this.enabled = true;
    try { await this.client.start({ consent: true, onMessage: event => this.onMessage(event) }); }
    catch (error) { this.stop(); throw error; }
  }
  stop() {
    this.enabled = false; this.client.stop(); this.clipboard.pause?.();
    for (const pending of this.waiters.values()) pending.reject(fail('stopped'));
    this.waiters.clear();
  }
  async reconnect() {
    if (!this.enabled) throw fail('paused');
    if (this.client.status().connected) return;
    await this.client.start({ consent: true, onMessage: event => this.onMessage(event) });
  }
  waitFor(id, expected, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(fail('timeout')); }, timeoutMs);
      this.waiters.set(id, { resolve: value => { clearTimeout(timer); this.waiters.delete(id); resolve(value); }, reject: error => { clearTimeout(timer); this.waiters.delete(id); reject(error); }, expected });
    });
  }
  async sendAndWait(message, expected) {
    const waiting = this.waitFor(message.id, expected);
    try { await this.client.send(message); } catch (error) { this.waiters.get(message.id)?.reject(error); }
    return waiting;
  }
  async sendClipboard(targetDeviceId, { consent = false, requestId = randomUUID() } = {}) {
    if (!this.enabled) throw fail('paused');
    if (!consent) throw fail('consent_required');
    if (!this.paired.has(targetDeviceId) || targetDeviceId === this.deviceId) throw fail('unpaired_target');
    const source = await this.clipboard.snapshot();
    if (source.origin?.transferId) throw fail('feedback_loop');
    const bytes = Buffer.from(source.text, 'utf8');
    if (!bytes.length || bytes.length > MAX_BYTES) throw fail('invalid_size');
    const prepared = await this.sendAndWait({ type: 'prepare', id: requestId, sourceDeviceId: this.deviceId, targetDeviceId }, 'prepared');
    if (!Number.isSafeInteger(prepared.targetRevision)) throw fail('invalid_prepare');
    const current = await this.clipboard.snapshot();
    if (current.revision !== source.revision || current.text !== source.text) throw fail('stale_source');
    const sequence = await this.state.update(data => ++data.nextSequence);
    const envelope = { version: 1, id: requestId, sequence, sourceDeviceId: this.deviceId, targetDeviceId, sourceRevision: source.revision, targetRevision: prepared.targetRevision, expiresAt: this.now() + 30_000, mime: MIME, byteLength: bytes.length, sha256: sha(bytes) };
    const transfer = { type: 'transfer', id: requestId, sourceDeviceId: this.deviceId, targetDeviceId, envelope, contentBase64: bytes.toString('base64') };
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.now() > envelope.expiresAt) throw fail('expired');
      try {
        const receipt = await this.sendAndWait(transfer, 'receipt');
        if (receipt.sha256 !== envelope.sha256 || receipt.sequence !== sequence || receipt.byteLength !== bytes.length || !terminal.has(receipt.state)) throw fail('invalid_receipt');
        if ((await this.clipboard.snapshot()).revision !== source.revision) throw fail('source_changed_during_delivery');
        return { envelope, receipt, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (!['timeout', 'offline'].includes(error.code)) throw error;
      }
    }
    throw lastError;
  }
  async onMessage(event) {
    if (!this.enabled || !event || !this.paired.has(event.authenticatedPeerId)) return;
    const message = event.message;
    if (!message || (['prepare', 'transfer'].includes(message.type) && message.targetDeviceId !== this.deviceId)) return;
    if (message.type === 'prepared' || message.type === 'receipt') {
      if (message.sourceDeviceId !== this.deviceId || message.targetDeviceId !== event.authenticatedPeerId) return;
      const waiter = this.waiters.get(message.id);
      if (waiter?.expected === message.type && (message.type !== 'receipt' || terminal.has(message.state))) waiter.resolve(message);
      return;
    }
    this.queue = this.queue.then(() => this.handleInbound(event.authenticatedPeerId, message)).catch(() => {});
    await this.queue;
  }
  async handleInbound(peerId, message) {
    if (message.sourceDeviceId !== peerId || message.targetDeviceId !== this.deviceId) return;
    if (message.type === 'prepare') {
      const snapshot = await this.clipboard.snapshot();
      await this.client.send({ type: 'prepared', id: message.id, sourceDeviceId: peerId, targetDeviceId: this.deviceId, targetRevision: snapshot.revision });
      return;
    }
    if (message.type !== 'transfer') return;
    const e = message.envelope;
    if (!e || e.id !== message.id || e.sourceDeviceId !== peerId || e.targetDeviceId !== this.deviceId || e.version !== 1 || !Number.isSafeInteger(e.sequence) || e.sequence < 1) return;
    const data = await this.state.load();
    const existing = data.receipts[e.id];
    if (existing) {
      if (existing.sha256 !== e.sha256 || existing.sequence !== e.sequence || existing.sourceDeviceId !== peerId) return;
      await this.client.send({ ...existing, type: 'receipt', id: e.id, duplicate: true });
      return;
    }
    if (data.inbound[e.id]) {
      await this.sendTerminal(e, 'ambiguous_after_restart');
      return;
    }
    if (this.now() > e.expiresAt) { await this.sendTerminal(e, 'expired'); return; }
    if (e.sequence <= (data.lastSequence[peerId] ?? 0)) return;
    const bytes = Buffer.from(message.contentBase64 || '', 'base64');
    if (bytes.toString('base64') !== message.contentBase64) { await this.sendTerminal(e, 'invalid_payload'); return; }
    let text;
    try { text = validatePayload(bytes, e); } catch { await this.sendTerminal(e, 'invalid_payload'); return; }
    await this.state.update(next => { next.inbound[e.id] = { sourceDeviceId: peerId, sequence: e.sequence, sha256: e.sha256 }; next.lastSequence[peerId] = e.sequence; });
    await this.client.send({ type: 'receipt', id: e.id, sourceDeviceId: peerId, targetDeviceId: this.deviceId, state: 'received', byteLength: e.byteLength });
    try {
      const revision = await this.clipboard.compareAndWrite(e.targetRevision, text, { transferId: e.id, sourceDeviceId: peerId });
      await this.client.send({ type: 'receipt', id: e.id, sourceDeviceId: peerId, targetDeviceId: this.deviceId, state: 'applied', byteLength: e.byteLength });
      const actual = await this.clipboard.snapshot();
      const state = actual.revision === revision && sha(Buffer.from(actual.text, 'utf8')) === e.sha256 ? 'verified' : 'verification_failed';
      await this.sendTerminal(e, state);
    } catch (error) {
      await this.sendTerminal(e, error.code === 'concurrent_change' ? 'concurrent_change' : 'permission_denied');
    }
  }
  async sendTerminal(e, state) {
    if (!terminal.has(state)) throw fail('invalid_state');
    const receipt = { id: e.id, sourceDeviceId: e.sourceDeviceId, targetDeviceId: this.deviceId, sequence: e.sequence, sha256: e.sha256, byteLength: e.byteLength, state };
    await this.state.update(data => { data.receipts[e.id] = receipt; delete data.inbound[e.id]; });
    await this.client.send({ ...receipt, type: 'receipt' });
  }
}
