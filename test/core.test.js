import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, Device, LoopbackTransport, MockClipboard, MIME, MAX_BYTES } from '../core.js';

function rig(text = 'hello', options = {}) {
  const source = new Device('mini', new MockClipboard(text));
  const target = new Device('laptop', new MockClipboard('prior'));
  source.enable(); target.enable();
  const transport = new LoopbackTransport();
  const controller = new Controller([source, target], transport, options);
  return { source, target, transport, controller };
}
const transfer = r => r.controller.transfer('mini', 'laptop', { consent: true });

for (const text of ['s', 'line 1\nline 2\n\nline 4', '雪 👩🏽‍💻 café \u0000', 'x'.repeat(MAX_BYTES)]) {
  test(`exact text roundtrip ${Buffer.byteLength(text)} bytes`, async () => {
    const r = rig(text); const result = await transfer(r);
    assert.equal(result.receipt.state, 'verified');
    assert.equal(r.target.clipboard.snapshot().text, text);
    assert.equal(result.envelope.byteLength, Buffer.byteLength(text));
    assert.deepEqual(Object.keys(r.controller.audit[0]).sort(), ['attempts', 'byteLength', 'sequence', 'sourceDeviceId', 'state', 'targetDeviceId', 'transferId'].sort());
  });
}

test('size, type, truncation, and invalid UTF-8 are rejected', async () => {
  await assert.rejects(transfer(rig('x'.repeat(MAX_BYTES + 1))), { code: 'invalid_size' });
  const r = rig(); const result = await transfer(r);
  const env = { ...result.envelope, id: 'other', sequence: 2, targetRevision: r.target.clipboard.revision };
  assert.throws(() => r.target.receive(env, Buffer.from('hell')), { code: 'integrity_failed' });
  assert.throws(() => r.target.receive({ ...env, mime: 'image/png' }, Buffer.from('hello')), { code: 'integrity_failed' });
  const invalid = Buffer.from([0xc3, 0x28]);
  const crypto = await import('node:crypto');
  assert.throws(() => r.target.receive({ ...env, byteLength: 2, sha256: crypto.createHash('sha256').update(invalid).digest('hex') }, invalid), { code: 'invalid_utf8' });
});

test('duplicate ACK loss applies only once; replay and reorder rejected', async () => {
  const r = rig(); r.transport.inject('ack_loss');
  const result = await transfer(r);
  assert.equal(result.audit.attempts, 2);
  assert.equal(result.receipt.duplicate, true);
  assert.equal(r.target.clipboard.writes, 1);
  const bytes = Buffer.from('hello');
  assert.throws(() => r.target.receive({ ...result.envelope, id: 'older', sequence: result.envelope.sequence, targetRevision: r.target.clipboard.revision }, bytes), { code: 'stale_sequence' });
  assert.throws(() => r.target.receive({ ...result.envelope, id: 'tampered', sequence: 3, targetRevision: r.target.clipboard.revision, expiresAt: Date.now() - 1 }, bytes), { code: 'expired' });
});

test('recipient emits distinct received, applied, and verified acknowledgements', async () => {
  const r = rig();
  const stages = [];
  const original = r.transport.send.bind(r.transport);
  r.transport.send = (target, envelope, bytes, onAck) => original(target, envelope, bytes, ack => { stages.push(ack.state); onAck(ack); });
  await transfer(r);
  assert.deepEqual(stages, ['received', 'applied', 'verified']);
});

test('loss, disconnect, reconnection, and bounded retry', async () => {
  const r = rig(); r.transport.inject('loss'); r.transport.inject('loss');
  assert.equal((await transfer(r)).audit.attempts, 3);
  const d = rig(); d.transport.inject('disconnect');
  await assert.rejects(transfer(d), { code: 'disconnected' });
  assert.equal(d.controller.audit[0].attempts, 3);
  d.transport.reconnect();
  assert.equal((await transfer(d)).receipt.state, 'verified');
});

test('source or target concurrent changes preserve user clipboard', async () => {
  const r = rig();
  const original = r.transport.send.bind(r.transport);
  r.transport.send = async (...args) => { r.target.clipboard.userWrite('new user text'); return original(...args); };
  await assert.rejects(transfer(r), { code: 'concurrent_change' });
  assert.equal(r.target.clipboard.snapshot().text, 'new user text');
  const s = rig();
  const sendS = s.transport.send.bind(s.transport);
  s.transport.send = async (...args) => { s.source.clipboard.userWrite('new source text'); return sendS(...args); };
  await assert.rejects(transfer(s), { code: 'source_changed_during_delivery' });
});

test('opt-in, pause, permission denial, and feedback guard', async () => {
  const r = rig();
  await assert.rejects(r.controller.transfer('mini', 'laptop'), { code: 'consent_required' });
  r.source.pause(); await assert.rejects(transfer(r), { code: 'paused' }); r.source.resume();
  r.target.clipboard.allowed = false; await assert.rejects(transfer(r), { code: 'permission_denied' });
  r.target.clipboard.allowed = true;
  const result = await transfer(r);
  assert.equal(r.target.shouldForward(r.target.clipboard.snapshot()), false);
  assert.equal(result.envelope.mime, MIME);
});
