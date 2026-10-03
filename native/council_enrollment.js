import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprint = /^[0-9a-f]{64}$/i;
const invitationCode = /^[A-Za-z0-9_-]{43}$/;
const fail = code => Object.assign(new Error(code), { code });

// Source-compatible with Council's owner-approved HTTP relay. Creating the
// invitation and approving the displayed fingerprint remain owner operations
// on Council; this client cannot approve itself or provision a pair key.
export class CouncilEnrollmentClient {
  constructor({ relayUrl, fetcher = fetch, getAuthorization }) {
    const url = new URL(relayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || typeof getAuthorization !== 'function') throw fail('invalid_configuration');
    this.relayUrl = url.origin;
    this.fetcher = fetcher;
    this.getAuthorization = getAuthorization;
  }

  async enroll({ pairingId, deviceId, code, identityFingerprint }) {
    if (!uuid.test(pairingId) || !uuid.test(deviceId) || !invitationCode.test(code) || !fingerprint.test(identityFingerprint)) throw fail('invalid_invitation');
    const auth = await this.getAuthorization();
    if (!auth || typeof auth.clientId !== 'string' || !auth.clientId || typeof auth.clientSecret !== 'string' || !auth.clientSecret) throw fail('credential_missing');
    const response = await this.fetcher(`${this.relayUrl}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Access-Client-Id': auth.clientId, 'CF-Access-Client-Secret': auth.clientSecret },
      body: JSON.stringify({ pairingId, deviceId, code, fingerprint: identityFingerprint.toLowerCase() }),
    });
    if (response.status !== 202) throw fail('enrollment_rejected');
    let result;
    try { result = await response.json(); } catch { throw fail('invalid_enrollment_response'); }
    if (result?.deviceId !== deviceId || result?.state !== 'pending_owner_approval') throw fail('invalid_enrollment_response');
    return { deviceId, state: result.state, identityFingerprint: identityFingerprint.toLowerCase() };
  }
}

export function pairKeyFingerprint(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('invalid_pair_key');
  return createHash('sha256').update(key).digest('hex');
}
