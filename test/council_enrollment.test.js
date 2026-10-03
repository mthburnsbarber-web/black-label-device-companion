import test from 'node:test';
import assert from 'node:assert/strict';
import { CouncilEnrollmentClient, pairKeyFingerprint, serviceCredentialFingerprint } from '../native/council_enrollment.js';

const pairingId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const code = 'a'.repeat(43);
const identityFingerprint = 'B'.repeat(64);

test('Council enrollment uses the device Access credential and awaits owner approval', async () => {
  let called = 0;
  const client = new CouncilEnrollmentClient({ relayUrl: 'https://devices.example.test/',
    getAuthorization: async () => ({ clientId: 'test-id', clientSecret: 'test-secret' }),
    fetcher: async (url, options) => {
      called++;
      assert.equal(url, 'https://devices.example.test/enroll');
      assert.equal(options.headers['CF-Access-Client-Id'], 'test-id');
      assert.equal(options.headers['CF-Access-Client-Secret'], 'test-secret');
      assert.deepEqual(JSON.parse(options.body), { pairingId, deviceId, code, fingerprint: identityFingerprint.toLowerCase() });
      return new Response(JSON.stringify({ deviceId, state: 'pending_owner_approval' }), { status: 202 });
    } });
  assert.deepEqual(await client.enroll({ pairingId, deviceId, code, identityFingerprint }),
    { deviceId, state: 'pending_owner_approval', identityFingerprint: identityFingerprint.toLowerCase() });
  assert.equal(called, 1);
});

test('bad invitations fail before credentials or network are accessed', async () => {
  let accessed = false;
  const client = new CouncilEnrollmentClient({ relayUrl: 'https://devices.example.test/',
    getAuthorization: async () => { accessed = true; throw new Error('should not run'); },
    fetcher: async () => { accessed = true; throw new Error('should not run'); } });
  await assert.rejects(client.enroll({ pairingId, deviceId, code: 'bad', identityFingerprint }), { code: 'invalid_invitation' });
  assert.equal(accessed, false);
});

test('enrollment cannot treat transport success as owner approval', async () => {
  const client = new CouncilEnrollmentClient({ relayUrl: 'https://devices.example.test/',
    getAuthorization: async () => ({ clientId: 'id', clientSecret: 'secret' }),
    fetcher: async () => new Response(JSON.stringify({ deviceId, state: 'paired' }), { status: 202 }) });
  await assert.rejects(client.enroll({ pairingId, deviceId, code, identityFingerprint }), { code: 'invalid_enrollment_response' });
});

test('pair key fingerprint accepts only a 32-byte key', () => {
  assert.equal(pairKeyFingerprint(Buffer.alloc(32)), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  assert.throws(() => pairKeyFingerprint(Buffer.alloc(31)), { code: 'invalid_pair_key' });
});

test('explicit enrollment derives the same bound token digest Council stores', async () => {
  const auth = { clientId: 'test-id', clientSecret: 'test-secret' };
  let credentialReads = 0;
  const expected = serviceCredentialFingerprint(auth);
  const client = new CouncilEnrollmentClient({ relayUrl: 'https://devices.example.test/',
    getAuthorization: async () => { credentialReads++; return auth; },
    fetcher: async (_url, options) => {
      assert.equal(JSON.parse(options.body).fingerprint, expected);
      return new Response(JSON.stringify({ deviceId, state: 'pending_owner_approval' }), { status: 202 });
    } });
  const result = await client.enrollWithCredentialFingerprint({ pairingId, deviceId, code });
  assert.equal(result.identityFingerprint, expected);
  assert.equal(result.state, 'pending_owner_approval');
  assert.equal(credentialReads, 1);
  await assert.rejects(client.enrollWithCredentialFingerprint({ pairingId, deviceId, code: 'bad' }), { code: 'invalid_invitation' });
  assert.equal(credentialReads, 1);
});
