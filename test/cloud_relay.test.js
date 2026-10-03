import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRelay, verifyDeviceAccess } from '../cloud/relay_worker.js';

function harness() {
  const frames = [];
  const env = { RELAY_DB: {}, ACCESS_TEAM_DOMAIN: 'team.example.test', DEVICE_AUDIENCES_JSON: JSON.stringify({ mini: 'aud-mini', laptop: 'aud-laptop' }), PAIRED_DEVICES_JSON: JSON.stringify({ mini: ['laptop'], laptop: ['mini'] }) };
  const store = { async prune(now) { for (let i = frames.length - 1; i >= 0; i--) if (frames[i].expiresAt <= now) frames.splice(i, 1); }, async put(frame) { const seq = frames.length + 1; frames.push({ seq, ...frame }); return seq; }, async list(to, after, now) { return frames.filter(frame => frame.to === to && frame.seq > after && frame.expiresAt > now).map(({ seq, from, payload, expiresAt }) => ({ seq, from, payload, expiresAt })); } };
  const options = { authenticate: async (_request, _env, deviceId) => deviceId === 'mini' || deviceId === 'laptop', store, now: () => 1000 };
  return { env, options, frames };
}

test('cloud relay routes only encrypted opaque frames to paired recipient and expires them', async () => {
  const h = harness();
  const payload = 'opaque-ciphertext';
  const posted = await handleRelay(new Request('https://relay.example.test/devices/mini/frames', { method: 'POST', body: JSON.stringify({ to: 'laptop', payload, expiresAt: 2000 }) }), h.env, h.options);
  assert.equal(posted.status, 202);
  const recipient = await handleRelay(new Request('https://relay.example.test/devices/laptop/frames?after=0'), h.env, h.options);
  assert.deepEqual((await recipient.json()).frames, [{ seq: 1, from: 'mini', payload, expiresAt: 2000 }]);
  const sender = await handleRelay(new Request('https://relay.example.test/devices/mini/frames?after=0'), h.env, h.options);
  assert.deepEqual((await sender.json()).frames, []);
  h.options.now = () => 2001;
  const expired = await handleRelay(new Request('https://relay.example.test/devices/laptop/frames?after=0'), h.env, h.options);
  assert.deepEqual((await expired.json()).frames, []);
});

test('cloud relay rejects unconfigured, unauthenticated, unpaired and oversized requests', async () => {
  const h = harness();
  const url = 'https://relay.example.test/devices/mini/frames';
  assert.equal((await handleRelay(new Request(url), {}, h.options)).status, 503);
  assert.equal((await handleRelay(new Request(url), h.env, { ...h.options, authenticate: async () => false })).status, 401);
  assert.equal((await handleRelay(new Request(url, { method: 'POST', body: JSON.stringify({ to: 'other', payload: 'x', expiresAt: 2000 }) }), h.env, h.options)).status, 400);
  assert.equal((await handleRelay(new Request(url, { method: 'POST', body: JSON.stringify({ to: 'laptop', payload: 'x'.repeat(230000), expiresAt: 2000 }) }), h.env, h.options)).status, 400);
  assert.equal((await handleRelay(new Request(`${url}?after=-1`), h.env, h.options)).status, 400);
});

test('Cloudflare Access JWT signature, audience, issuer and expiry are checked', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key' };
  const env = { ACCESS_TEAM_DOMAIN: 'team.example.test', DEVICE_AUDIENCES_JSON: JSON.stringify({ mini: 'aud-mini' }) };
  const fetcher = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = async claims => {
    const header = b64({ alg: 'RS256', kid: 'test-key' }), body = b64(claims);
    const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${header}.${body}`))).toString('base64url');
    return `${header}.${body}.${signature}`;
  };
  const claims = { iss: 'https://team.example.test', aud: ['aud-mini'], exp: Date.now() / 1000 + 60 };
  const token = await sign(claims);
  const request = value => new Request('https://relay.example.test/devices/mini/health', { headers: { 'Cf-Access-Jwt-Assertion': value } });
  assert.equal(await verifyDeviceAccess(request(token), env, 'mini', fetcher), true);
  assert.equal(await verifyDeviceAccess(request(token), { ...env, DEVICE_AUDIENCES_JSON: JSON.stringify({ mini: 'aud-mini', laptop: 'aud-mini' }) }, 'mini', fetcher), false);
  assert.equal(await verifyDeviceAccess(request(await sign({ ...claims, aud: ['other'] })), env, 'mini', fetcher), false);
  assert.equal(await verifyDeviceAccess(request(await sign({ ...claims, exp: 1 })), env, 'mini', fetcher), false);
  assert.equal(await verifyDeviceAccess(request(`${token.slice(0, -2)}xx`), env, 'mini', fetcher), false);
});
