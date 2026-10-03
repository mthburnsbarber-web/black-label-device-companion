import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
const aad = (from, to) => Buffer.from(`black-label-device-v1\0${from}\0${to}`, 'utf8');

// AES-256-GCM frame codec. A separate approved pairing flow must provision a
// unique 32-byte pair key into an OS credential store; this code creates none.
export class PairwiseAeadCodec {
  constructor({ deviceId, keyForPeer }) {
    if (!validId(deviceId) || typeof keyForPeer !== 'function') throw fail('invalid_configuration');
    this.deviceId = deviceId; this.keyForPeer = keyForPeer;
  }
  async key(peerId) {
    if (!validId(peerId) || peerId === this.deviceId) throw fail('invalid_peer');
    const key = await this.keyForPeer(peerId);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('pairing_required');
    return key;
  }
  async seal(message, to) {
    const key = await this.key(to);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(this.deviceId, to));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, from: this.deviceId, to, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
  }
  async open(payload, expectedFrom) {
    let frame;
    try { frame = JSON.parse(payload); } catch { throw fail('invalid_frame'); }
    if (frame?.v !== 1 || frame.to !== this.deviceId || !validId(frame.from) || (expectedFrom && frame.from !== expectedFrom)) throw fail('invalid_frame');
    const key = await this.key(frame.from);
    try {
      const nonce = Buffer.from(frame.nonce, 'base64url'), tag = Buffer.from(frame.tag, 'base64url'), ciphertext = Buffer.from(frame.ciphertext, 'base64url');
      if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > 200_000) throw fail('invalid_frame');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad(frame.from, this.deviceId)); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    } catch { throw fail('integrity_failed'); }
  }
}
