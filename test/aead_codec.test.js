import test from 'node:test';
import assert from 'node:assert/strict';
import { PairwiseAeadCodec } from '../native/aead_codec.js';

test('pairwise AEAD encrypts and authenticates source, target, and payload', async () => {
  const key = Buffer.alloc(32, 7); // Test fixture only; no production key is created.
  const a = new PairwiseAeadCodec({ deviceId: 'mini', keyForPeer: async peer => peer === 'laptop' ? key : null });
  const b = new PairwiseAeadCodec({ deviceId: 'laptop', keyForPeer: async peer => peer === 'mini' ? key : null });
  const payload = await a.seal({ type: 'transfer', text: '雪\n🙂' }, 'laptop');
  assert.equal(payload.includes('雪'), false);
  assert.deepEqual(await b.open(payload, 'mini'), { type: 'transfer', text: '雪\n🙂' });
  await assert.rejects(b.open(payload, 'other'), { code: 'invalid_frame' });
  const frame = JSON.parse(payload);
  frame.ciphertext = Buffer.from('tampered').toString('base64url');
  await assert.rejects(b.open(JSON.stringify(frame), 'mini'), { code: 'integrity_failed' });
  frame.to = 'other';
  await assert.rejects(b.open(JSON.stringify(frame), 'mini'), { code: 'invalid_frame' });
});
