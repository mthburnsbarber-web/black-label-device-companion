import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockClipboard } from '../core.js';
import { NativeCompanion } from '../native/companion.js';
import { FileState } from '../native/state.js';
import { LoopbackHttpRelay, HttpRelayClient } from '../native/http_relay.js';
import { PairwiseAeadCodec } from '../native/aead_codec.js';

test('two companions transfer exact Unicode text over real loopback HTTP sockets', { skip: !process.env.RUN_LOOPBACK }, async () => {
  const relay = new LoopbackHttpRelay({ mini: 'test-mini-token', laptop: 'test-laptop-token' });
  const baseUrl = await relay.start();
  const dir = await mkdtemp(join(tmpdir(), 'blacklabel-http-test-'));
  const key = Buffer.alloc(32, 9); // Test fixture only.
  const miniCodec = new PairwiseAeadCodec({ deviceId: 'mini', keyForPeer: async () => key });
  const laptopCodec = new PairwiseAeadCodec({ deviceId: 'laptop', keyForPeer: async () => key });
  const miniClient = new HttpRelayClient({ deviceId: 'mini', baseUrl, getAuthorization: async () => 'test-mini-token', seal: (message, to) => miniCodec.seal(message, to), open: (payload, from) => miniCodec.open(payload, from), pollMs: 5, allowLoopback: true });
  const laptopClient = new HttpRelayClient({ deviceId: 'laptop', baseUrl, getAuthorization: async () => 'test-laptop-token', seal: (message, to) => laptopCodec.seal(message, to), open: (payload, from) => laptopCodec.open(payload, from), pollMs: 5, allowLoopback: true });
  const source = new MockClipboard('s\n雪 😀');
  const target = new MockClipboard('older');
  const mini = new NativeCompanion({ deviceId: 'mini', clipboard: source, client: miniClient, state: new FileState(join(dir, 'mini.json')), pairedDeviceIds: ['laptop'], timeoutMs: 300 });
  const laptop = new NativeCompanion({ deviceId: 'laptop', clipboard: target, client: laptopClient, state: new FileState(join(dir, 'laptop.json')), pairedDeviceIds: ['mini'], timeoutMs: 300 });
  try {
    await mini.start({ consent: true }); await laptop.start({ consent: true });
    const result = await mini.sendClipboard('laptop', { consent: true });
    assert.equal(result.receipt.state, 'verified');
    assert.equal(result.attempts, 1);
    assert.equal(target.snapshot().text, 's\n雪 😀');
    assert.equal(target.writes, 1);
    assert.equal(mini.status().connected, true);
    assert.equal(JSON.stringify([...relay.messages.values()]).includes('雪'), false);
  } finally { await Promise.all([mini.stop(), laptop.stop()]); await relay.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('relay rejects wrong token and non-loopback plaintext endpoints', { skip: !process.env.RUN_LOOPBACK }, async () => {
  const relay = new LoopbackHttpRelay({ mini: 'good' });
  const baseUrl = await relay.start();
  try {
    const denied = await fetch(`${baseUrl}/health`, { headers: { 'x-device-id': 'mini', authorization: 'Bearer bad' } });
    assert.equal(denied.status, 401);
    assert.throws(() => new HttpRelayClient({ deviceId: 'mini', baseUrl: 'http://example.com', getAuthorization() {}, seal() {}, open() {} }), { code: 'invalid_configuration' });
  } finally { await relay.stop(); }
});

test('HTTPS client sends Cloudflare service-token headers supplied by credential provider', async () => {
  let headers;
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => ({ clientId: 'test-id', clientSecret: 'test-secret' }), seal: async () => 'sealed', open: async () => ({}), fetcher: async (_url, options) => { headers = options.headers; return { ok: true }; }, pollMs: 100000 });
  try {
    await client.start({ consent: true });
    assert.equal(headers['CF-Access-Client-Id'], 'test-id');
    assert.equal(headers['CF-Access-Client-Secret'], 'test-secret');
    assert.equal(headers.authorization, undefined);
  } finally { client.stop(); }
});

test('transport ACK follows processing and retries after ACK loss without reapplying', async () => {
  let handled = 0, ackCalls = 0;
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }));
    if (url.includes('/ack')) return new Response(JSON.stringify({ ok: true }), { status: ++ackCalls === 1 ? 503 : 200 });
    if (url.endsWith('after=0')) return new Response(JSON.stringify({ frames: [{ seq: 7, from: 'laptop', payload: 'encrypted', expiresAt: Date.now() + 10000 }] }));
    return new Response(JSON.stringify({ frames: [] }));
  };
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => 'test', seal: async () => 'encrypted', open: async () => ({ type: 'receipt' }), fetcher, pollMs: 100000 });
  try {
    await client.start({ consent: true, onMessage: async () => { handled++; } });
    await assert.rejects(client.poll(), { code: 'transport_ack_failed' });
    assert.equal(handled, 1);
    assert.equal(client.status().pendingTransportAcks, 1);
    assert.equal(client.status().lastTransportAckSeq, 0);
    await client.poll();
    assert.equal(handled, 1);
    assert.equal(client.status().pendingTransportAcks, 0);
    assert.equal(client.status().lastTransportAckSeq, 7);
    assert.equal(ackCalls, 2);
    assert.ok(urls.indexOf('https://relay.example.test/frames/7/ack') > urls.indexOf('https://relay.example.test/frames?after=0'));
  } finally { client.stop(); }
});

test('failed frame processing does not advance cursor or transport ACK', async () => {
  let ackCalls = 0, handled = 0;
  const fetcher = async url => url.endsWith('/health') ? new Response('{}')
    : url.includes('/ack') ? (ackCalls++, new Response('{}'))
    : new Response(JSON.stringify({ frames: [{ seq: 2, from: 'laptop', payload: 'encrypted' }] }));
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => 'test', seal: async () => 'encrypted', open: async () => ({}), fetcher, pollMs: 100000 });
  try {
    await client.start({ consent: true, onMessage: async () => { handled++; if (handled === 1) throw Error('durability failure'); } });
    await assert.rejects(client.poll(), /durability failure/);
    assert.equal(client.cursor, 0);
    assert.equal(ackCalls, 0);
    await client.poll();
    assert.equal(handled, 2);
    assert.equal(client.cursor, 2);
    assert.equal(ackCalls, 1);
  } finally { client.stop(); }
});

test('relay enqueue response is queued, never an application verification', async () => {
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => 'test', seal: async () => 'encrypted', open: async () => ({}), pollMs: 100000,
    fetcher: async (url, options) => url.endsWith('/health') ? new Response('{}')
      : options?.method === 'POST' ? new Response('{"seq":9}', { status: 202 })
      : new Response('{"frames":[]}') });
  try {
    await client.start({ consent: true });
    assert.deepEqual(await client.send({ type: 'prepare', targetDeviceId: 'laptop' }), { state: 'queued', seq: 9 });
    assert.equal(client.status().lastTransportAckSeq, 0);
  } finally { client.stop(); }
});

test('network request timeout is bounded for an unresponsive relay', async () => {
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => 'test', seal: async () => 'encrypted', open: async () => ({}), requestTimeoutMs: 5,
    fetcher: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })))) });
  await assert.rejects(client.start({ consent: true }), { code: 'timeout' });
  assert.equal(client.status().enabled, false);
});

test('pause during GET cannot skip a frame on same-client resume', async () => {
  let releaseOldGet;
  const oldGet = new Promise(resolve => { releaseOldGet = resolve; });
  let gets = 0, delivered = 0, acks = 0;
  const frame = { seq: 1, from: 'laptop', payload: 'encrypted' };
  const fetcher = async url => {
    if (url.endsWith('/health')) return new Response('{}');
    if (url.endsWith('/ack')) { acks++; return new Response('{}'); }
    gets++;
    if (gets === 1) return oldGet;
    return new Response(JSON.stringify({ frames: [frame] }));
  };
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => 'test', seal: async () => 'encrypted', open: async () => ({}), fetcher, pollMs: 100000 });
  try {
    await client.start({ consent: true, onMessage: async () => { delivered++; } });
    const stalePoll = client.poll();
    await new Promise(resolve => setImmediate(resolve));
    client.stop();
    await client.start({ consent: true, onMessage: async () => { delivered++; } });
    releaseOldGet(new Response(JSON.stringify({ frames: [frame] })));
    await stalePoll;
    assert.equal(delivered, 0);
    assert.equal(client.cursor, 0);
    assert.equal(acks, 0);
    await client.poll();
    assert.equal(delivered, 1);
    assert.equal(client.cursor, 1);
    assert.equal(acks, 1);
  } finally { client.stop(); }
});

test('stop during frame handler preserves replay after restart', async () => {
  let delivered = 0, acks = 0;
  const frame = { seq: 1, from: 'laptop', payload: 'encrypted' };
  const fetcher = async url => url.endsWith('/health') ? new Response('{}')
    : url.endsWith('/ack') ? (acks++, new Response('{}'))
    : new Response(JSON.stringify({ frames: [frame] }));
  const client = new HttpRelayClient({ deviceId: 'mini', baseUrl: 'https://relay.example.test', getAuthorization: async () => 'test', seal: async () => 'encrypted', open: async () => ({}), fetcher, pollMs: 100000 });
  try {
    await client.start({ consent: true, onMessage: async () => { delivered++; client.stop(); } });
    await client.poll();
    assert.equal(client.cursor, 0);
    assert.equal(acks, 0);
    await client.start({ consent: true, onMessage: async () => { delivered++; } });
    await client.poll();
    assert.equal(delivered, 2); // Durable application IDs must make replay idempotent.
    assert.equal(client.cursor, 1);
    assert.equal(acks, 1);
  } finally { client.stop(); }
});
