import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockClipboard } from '../core.js';
import { FileState } from '../native/state.js';
import { NativeCompanion } from '../native/companion.js';
import { memoryRelayPair } from '../native/memory_relay.js';

async function rig(text = 'line\n雪 🙂') {
  const dir = await mkdtemp(join(tmpdir(), 'blacklabel-companion-'));
  const [a, b] = memoryRelayPair('mini', 'laptop');
  const source = new MockClipboard(text), target = new MockClipboard('prior');
  const mini = new NativeCompanion({ deviceId: 'mini', clipboard: source, client: a, state: new FileState(join(dir, 'mini.json')), pairedDeviceIds: ['laptop'], timeoutMs: 20 });
  const laptop = new NativeCompanion({ deviceId: 'laptop', clipboard: target, client: b, state: new FileState(join(dir, 'laptop.json')), pairedDeviceIds: ['mini'], timeoutMs: 20 });
  await mini.start({ consent: true }); await laptop.start({ consent: true });
  return { dir, mini, laptop, source, target, a, b, close: async () => { await Promise.all([mini.stop(), laptop.stop()]); await rm(dir, { recursive: true, force: true }); } };
}

test('assembled companions transfer and verify Unicode through memory relay only', async () => {
  const r = await rig();
  try {
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.receipt.state, 'verified');
    assert.equal(r.target.snapshot().text, 'line\n雪 🙂');
    assert.equal(r.target.writes, 1);
    assert.equal(r.laptop.status().connected, true);
    const file = await readFile(join(r.dir, 'laptop.json'), 'utf8');
    assert.equal(file.includes('line\n雪'), false);
    await assert.rejects(r.laptop.sendClipboard('mini', { consent: true }), { code: 'feedback_loop' });
  } finally { await r.close(); }
});

test('restart preserves receipt and sequence metadata without clipboard content', async () => {
  const r = await rig('private marker');
  try {
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    await r.laptop.stop();
    const replacement = new NativeCompanion({ deviceId: 'laptop', clipboard: r.target, client: r.b, state: new FileState(join(r.dir, 'laptop.json')), pairedDeviceIds: ['mini'] });
    await replacement.start({ consent: true });
    const persisted = JSON.parse(await readFile(join(r.dir, 'laptop.json'), 'utf8'));
    assert.equal(persisted.lastSequence.mini, result.envelope.sequence);
    assert.equal(persisted.receipts[result.envelope.id].state, 'verified');
    assert.equal(JSON.stringify(persisted).includes('private marker'), false);
    await replacement.stop();
  } finally { await r.close(); }
});

test('lost final ACK retries same ID; durable receipt prevents second write', async () => {
  const r = await rig('s');
  try {
    r.b.dropVerifiedOnce = true;
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.attempts, 2);
    assert.equal(result.receipt.duplicate, true);
    assert.equal(r.target.writes, 1);
  } finally { await r.close(); }
});

test('lost applied receipt still produces verified readback and terminal receipt', async () => {
  const r = await rig('harmless');
  try {
    const original = r.b.send.bind(r.b);
    r.b.send = async message => {
      if (message.state === 'applied') throw Object.assign(new Error('offline'), { code: 'offline' });
      return original(message);
    };
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.receipt.state, 'verified');
    assert.equal(r.target.writes, 1);
    const persisted = JSON.parse(await readFile(join(r.dir, 'laptop.json'), 'utf8'));
    assert.equal(persisted.receipts[result.envelope.id].state, 'verified');
  } finally { await r.close(); }
});

test('target change between prepare and write is preserved', async () => {
  const r = await rig();
  try {
    const original = r.a.send.bind(r.a);
    r.a.send = async message => { if (message.type === 'transfer') r.target.userWrite('user changed'); return original(message); };
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.receipt.state, 'concurrent_change');
    assert.equal(r.target.snapshot().text, 'user changed');
  } finally { await r.close(); }
});

test('native write failure after clipboard empty is never reported as a simple denial', async () => {
  const r = await rig('harmless');
  try {
    r.target.compareAndWrite = () => { throw Object.assign(new Error('write_failed_after_empty'), { code: 'write_failed_after_empty' }); };
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.receipt.state, 'verification_failed');
    assert.equal(r.target.snapshot().text, 'prior');
  } finally { await r.close(); }
});

test('pausing after received ACK prevents a queued native clipboard write', async () => {
  const r = await rig('harmless');
  try {
    const original = r.b.send.bind(r.b);
    r.b.send = async message => {
      if (message.state === 'received') { void r.laptop.stop(); return; }
      return original(message);
    };
    const result = await r.mini.sendClipboard('laptop', { consent: true, requestId: 'paused-test' });
    assert.equal(result.receipt.state, 'paused');
    assert.equal(r.target.writes, 0);
    assert.equal(r.target.snapshot().text, 'prior');
    const persisted = JSON.parse(await readFile(join(r.dir, 'laptop.json'), 'utf8'));
    assert.equal(persisted.receipts['paused-test'].state, 'paused');
  } finally { await r.close(); }
});

test('pause drains an already launched clipboard write and preserves its verified outcome', async () => {
  const r = await rig('harmless');
  try {
    let launched;
    const started = new Promise(resolve => { launched = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const original = r.target.compareAndWrite.bind(r.target);
    r.target.compareAndWrite = async (...args) => { launched(); await gate; return original(...args); };
    const sending = r.mini.sendClipboard('laptop', { consent: true });
    await started;
    const stopping = r.laptop.stop();
    assert.equal(r.laptop.status().draining, true);
    assert.equal(r.b.status().connected, true);
    assert.equal(r.target.writes, 0);
    release();
    const result = await sending;
    await stopping;
    assert.equal(result.receipt.state, 'verified');
    assert.equal(r.target.writes, 1);
    assert.equal(r.target.snapshot().text, 'harmless');
    assert.equal(r.laptop.status().draining, false);
    assert.equal(r.b.status().connected, false);
  } finally { await r.close(); }
});

test('helper timeout after a possible write is reported unverified when pause drains', async () => {
  const r = await rig('harmless');
  try {
    let launched;
    const started = new Promise(resolve => { launched = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const original = r.target.compareAndWrite.bind(r.target);
    r.target.compareAndWrite = async (...args) => {
      launched(); await gate; original(...args);
      throw Object.assign(new Error('native_helper_timeout'), { code: 'native_helper_timeout' });
    };
    const sending = r.mini.sendClipboard('laptop', { consent: true });
    await started;
    const stopping = r.laptop.stop();
    release();
    const result = await sending;
    await stopping;
    assert.equal(result.receipt.state, 'verification_failed');
    assert.equal(r.target.writes, 1); // Timed-out subprocess may already have written.
    assert.equal(r.laptop.status().draining, false);
  } finally { await r.close(); }
});

test('explicit consent and stop gate all operations', async () => {
  const r = await rig();
  try {
    await assert.rejects(r.mini.sendClipboard('laptop'), { code: 'consent_required' });
    await r.mini.stop();
    await assert.rejects(r.mini.sendClipboard('laptop', { consent: true }), { code: 'paused' });
    assert.equal(r.a.connected, false);
  } finally { await r.close(); }
});

test('offline target blocks prepare; reconnect permits a new attempt', async () => {
  const r = await rig();
  try {
    r.b.stop();
    await assert.rejects(r.mini.sendClipboard('laptop', { consent: true }), { code: 'offline' });
    await r.laptop.reconnect();
    const result = await r.mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.receipt.state, 'verified');
  } finally { await r.close(); }
});

test('simultaneous source sequence allocations are serialized on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blacklabel-state-'));
  try {
    const state = new FileState(join(dir, 'state.json'));
    const numbers = await Promise.all(Array.from({ length: 12 }, () => state.update(data => ++data.nextSequence)));
    assert.deepEqual(numbers.sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).nextSequence, 12);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
