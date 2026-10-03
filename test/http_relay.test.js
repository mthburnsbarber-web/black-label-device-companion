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
  } finally { mini.stop(); laptop.stop(); await relay.stop(); await rm(dir, { recursive: true, force: true }); }
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
