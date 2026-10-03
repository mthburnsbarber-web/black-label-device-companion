import test from 'node:test';
import assert from 'node:assert/strict';
import { MacOSClipboard } from '../native/macos.js';
import { OutboundCompanionClient } from '../native/outbound.js';

test('macOS adapter is inert until opt-in, then uses injected subprocess only', async () => {
  const calls = [];
  let revision = 4, text = '雪\n🙂';
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'read') return { code: 0, stdout: JSON.stringify({ revision, contentBase64: Buffer.from(text).toString('base64') }) };
    if (Number(args[1]) !== revision) return { code: 3, stdout: JSON.stringify({ error: 'concurrent_change' }) };
    text = input.toString('utf8'); revision += 2;
    return { code: 0, stdout: JSON.stringify({ revision }) };
  };
  const adapter = new MacOSClipboard({ run, platform: 'darwin' });
  assert.deepEqual(adapter.capabilities(), { clipboardText: true, enabled: false, inputControl: false });
  await assert.rejects(adapter.snapshot(), { code: 'paused' });
  assert.equal(calls.length, 0);
  assert.throws(() => adapter.activate(), { code: 'consent_required' });
  adapter.activate({ consent: true });
  const before = await adapter.snapshot();
  assert.equal(before.text, '雪\n🙂');
  const next = await adapter.compareAndWrite(before.revision, 'exact\ntext', { transferId: 'x' });
  assert.equal(next, 6);
  assert.deepEqual((await adapter.snapshot()).origin, { transferId: 'x' });
  await assert.rejects(adapter.compareAndWrite(4, 'stale', null), { code: 'concurrent_change' });
  adapter.pause();
  await assert.rejects(adapter.snapshot(), { code: 'paused' });
  assert.equal(calls[1].input.toString(), 'exact\ntext');
});

test('macOS adapter rejects unsupported platform and malformed native responses', async () => {
  const other = new MacOSClipboard({ platform: 'win32', run: () => { throw Error('must not run'); } });
  assert.throws(() => other.activate({ consent: true }), { code: 'unsupported_platform' });
  const bad = new MacOSClipboard({ platform: 'darwin', run: async () => ({ code: 0, stdout: '{"revision":1,"contentBase64":"@@"}' }) });
  bad.activate({ consent: true });
  await assert.rejects(bad.snapshot(), { code: 'invalid_native_response' });
});

class FakeSocket {
  constructor() { this.listeners = new Map(); this.sent = []; this.closed = false; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  emit(type, data) { this.listeners.get(type)?.({ data }); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; this.emit('close'); }
}

test('outbound client requires consent and external pairing, encrypts frames, and stops', async () => {
  const socket = new FakeSocket(); let opened = 0, received = null;
  const client = new OutboundCompanionClient({ deviceId: 'mini', relayUrl: 'wss://relay.example.test/devices', getAuthorization: async () => 'test-token', seal: async value => `sealed:${value.id}`, open: async value => { opened++; return value; }, socketFactory: () => socket });
  await assert.rejects(client.start(), { code: 'consent_required' });
  assert.equal(client.status().enabled, false);
  await client.start({ consent: true, onMessage: value => { received = value; } });
  await assert.rejects(client.send({ id: 1 }), { code: 'offline' });
  socket.emit('open');
  assert.equal(socket.sent[0].authorization, 'test-token');
  socket.emit('message', JSON.stringify({ type: 'authenticated', deviceId: 'mini' }));
  await client.send({ id: 7 });
  assert.equal(socket.sent[1].payload, 'sealed:7');
  socket.emit('message', JSON.stringify({ type: 'encrypted', payload: 'ciphertext' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, 'ciphertext'); assert.equal(opened, 1);
  client.stop(); assert.equal(socket.closed, true);
  await assert.rejects(client.send({ id: 8 }), { code: 'offline' });
});

test('outbound client refuses plaintext URL and missing pairing', async () => {
  assert.throws(() => new OutboundCompanionClient({ deviceId: 'mini', relayUrl: 'ws://localhost:1', getAuthorization() {}, seal() {}, open() {} }), { code: 'invalid_configuration' });
  const client = new OutboundCompanionClient({ deviceId: 'mini', relayUrl: 'wss://relay.example.test', getAuthorization: async () => null, seal() {}, open() {}, socketFactory: () => { throw Error('must not connect'); } });
  await assert.rejects(client.start({ consent: true }), { code: 'pairing_required' });
});
