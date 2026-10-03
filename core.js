import { createHash, randomUUID } from 'node:crypto';

export const MAX_BYTES = 64 * 1024;
export const MIME = 'text/plain;charset=utf-8';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);

export function validatePayload(bytes, meta) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw fail('invalid_size');
  if (meta.mime !== MIME || meta.byteLength !== bytes.length || meta.sha256 !== hash(bytes)) throw fail('integrity_failed');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('invalid_utf8'); }
  if (Buffer.from(text, 'utf8').length !== bytes.length) throw fail('invalid_utf8');
  return text;
}

// Only an in-memory test adapter. Native clipboard access belongs in a later, approved companion.
export class MockClipboard {
  constructor(text = '') { this.text = text; this.revision = 0; this.origin = null; this.allowed = true; this.writes = 0; }
  snapshot() { if (!this.allowed) throw fail('permission_denied'); return { text: this.text, revision: this.revision, origin: this.origin }; }
  compareAndWrite(expectedRevision, text, origin) {
    if (!this.allowed) throw fail('permission_denied');
    if (this.revision !== expectedRevision) throw fail('concurrent_change');
    this.text = text; this.origin = origin; this.revision++; this.writes++;
    return this.revision;
  }
  userWrite(text) { this.text = text; this.origin = null; this.revision++; }
}

export class Device {
  constructor(id, clipboard = new MockClipboard()) {
    if (!validId(id)) throw fail('invalid_device');
    this.id = id; this.clipboard = clipboard; this.optedIn = false; this.paused = true;
    this.lastSequence = new Map(); this.receipts = new Map(); this.nextSequence = 0;
  }
  enable() { this.optedIn = true; this.paused = false; }
  pause() { this.paused = true; }
  resume() { if (!this.optedIn) throw fail('opt_in_required'); this.paused = false; }
  assertReady() { if (!this.optedIn) throw fail('opt_in_required'); if (this.paused) throw fail('paused'); }
  status() { return { id: this.id, pairing: 'mock_only', optedIn: this.optedIn, paused: this.paused, capabilities: ['clipboard_text_mock'] }; }
  receive(envelope, bytes, onAck = () => {}) {
    this.assertReady();
    if (envelope.targetDeviceId !== this.id || !validId(envelope.sourceDeviceId) || envelope.sourceDeviceId === this.id || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || typeof envelope.id !== 'string') throw fail('invalid_envelope');
    if (!Number.isFinite(envelope.expiresAt) || Date.now() > envelope.expiresAt) throw fail('expired');
    const text = validatePayload(bytes, envelope);
    const prior = this.receipts.get(envelope.id);
    if (prior) {
      if (prior.sha256 !== envelope.sha256 || prior.sourceDeviceId !== envelope.sourceDeviceId || prior.sequence !== envelope.sequence) throw fail('id_collision');
      const duplicate = { ...prior, duplicate: true }; onAck(duplicate); return duplicate;
    }
    const last = this.lastSequence.get(envelope.sourceDeviceId) ?? 0;
    if (envelope.sequence <= last) throw fail('stale_sequence');
    const received = { transferId: envelope.id, deviceId: this.id, sourceDeviceId: envelope.sourceDeviceId, sequence: envelope.sequence, state: 'received', sha256: envelope.sha256, byteLength: bytes.length };
    onAck(received);
    // This revision was observed at initiation. Never overwrite a user's newer clipboard value.
    const revision = this.clipboard.compareAndWrite(envelope.targetRevision, text, { transferId: envelope.id, sourceDeviceId: envelope.sourceDeviceId });
    const applied = { ...received, state: 'applied' };
    onAck(applied);
    this.lastSequence.set(envelope.sourceDeviceId, envelope.sequence);
    const actual = this.clipboard.snapshot();
    const verified = actual.revision === revision && actual.origin?.transferId === envelope.id && hash(Buffer.from(actual.text, 'utf8')) === envelope.sha256;
    const receipt = { ...applied, state: verified ? 'verified' : 'verification_failed' };
    this.receipts.set(envelope.id, receipt);
    onAck(receipt);
    return receipt;
  }
  shouldForward(snapshot) { return this.optedIn && !this.paused && !snapshot.origin?.transferId; }
}

export class LoopbackTransport {
  constructor() { this.connected = true; this.faults = []; }
  inject(fault) { this.faults.push(fault); }
  async send(target, envelope, bytes, onAck) {
    if (!this.connected) throw fail('disconnected');
    const fault = this.faults.shift();
    if (fault === 'disconnect') { this.connected = false; throw fail('disconnected'); }
    if (fault === 'loss') throw fail('timeout');
    const acknowledgements = [];
    const receipt = target.receive(envelope, bytes, ack => acknowledgements.push(ack));
    if (fault === 'ack_loss') throw fail('timeout');
    if (fault === 'delay') await new Promise(resolve => setTimeout(resolve, 50));
    for (const ack of acknowledgements) onAck?.(ack);
    return receipt;
  }
  reconnect() { this.connected = true; }
}

export class Controller {
  constructor(devices, transport = new LoopbackTransport(), { timeoutMs = 100, maxAttempts = 3 } = {}) {
    this.devices = new Map(devices.map(d => [d.id, d])); this.transport = transport;
    this.timeoutMs = timeoutMs; this.maxAttempts = maxAttempts; this.audit = [];
  }
  async transfer(sourceId, targetId, { consent = false, requestId = randomUUID() } = {}) {
    if (consent !== true) throw fail('consent_required');
    const source = this.devices.get(sourceId), target = this.devices.get(targetId);
    if (!source || !target || source === target) throw fail('invalid_devices');
    source.assertReady(); target.assertReady();
    const initial = source.clipboard.snapshot(), destination = target.clipboard.snapshot();
    if (!source.shouldForward(initial)) throw fail('feedback_loop');
    const bytes = Buffer.from(initial.text, 'utf8');
    const envelope = { version: 1, id: requestId, sequence: ++source.nextSequence, sourceDeviceId: sourceId, targetDeviceId: targetId, targetRevision: destination.revision, expiresAt: Date.now() + 30_000, mime: MIME, byteLength: bytes.length, sha256: hash(bytes) };
    validatePayload(bytes, envelope);
    const record = { transferId: envelope.id, sourceDeviceId: sourceId, targetDeviceId: targetId, sequence: envelope.sequence, byteLength: envelope.byteLength, state: 'pending', attempts: 0 };
    this.audit.push(record);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      record.attempts = attempt;
      try {
        source.assertReady(); target.assertReady();
        const current = source.clipboard.snapshot();
        if (current.revision !== initial.revision || current.text !== initial.text) throw fail('stale_source');
        const receipt = await Promise.race([this.transport.send(target, envelope, bytes, ack => { record.state = ack.state; }), new Promise((_, reject) => setTimeout(() => reject(fail('timeout')), this.timeoutMs))]);
        if (receipt.transferId !== envelope.id || receipt.deviceId !== targetId || receipt.sha256 !== envelope.sha256 || receipt.byteLength !== bytes.length) throw fail('invalid_receipt');
        if (source.clipboard.snapshot().revision !== initial.revision) throw fail('source_changed_during_delivery');
        record.state = receipt.state;
        return { envelope, receipt, audit: { ...record } };
      } catch (error) {
        record.state = error.code || 'transport_error';
        if (!['timeout', 'disconnected'].includes(error.code) || attempt === this.maxAttempts) throw Object.assign(error, { audit: { ...record } });
      }
    }
  }
}
