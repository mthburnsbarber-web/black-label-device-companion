import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprint = /^[0-9a-f]{64}$/i;
const invitationCode = /^[A-Za-z0-9_-]{43}$/;
const fail = code => Object.assign(new Error(code), { code });
const validInvitation = ({ pairingId, deviceId, code }) => uuid.test(pairingId) && uuid.test(deviceId) && invitationCode.test(code);

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
    if (!validInvitation({ pairingId, deviceId, code }) || !fingerprint.test(identityFingerprint)) throw fail('invalid_invitation');
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

  async enrollWithCredentialFingerprint({ pairingId, deviceId, code }) {
    if (!validInvitation({ pairingId, deviceId, code })) throw fail('invalid_invitation');
    const auth = await this.getAuthorization();
    const identityFingerprint = serviceCredentialFingerprint(auth);
    const client = new CouncilEnrollmentClient({ relayUrl: this.relayUrl, fetcher: this.fetcher, getAuthorization: async () => auth });
    return client.enroll({ pairingId, deviceId, code, identityFingerprint });
  }
}

// The fingerprint binds the owner's visual comparison to the exact service
// credential pair Council itself hashes as the device identity. It is not a
// hardware attestation or a replacement for the pairwise encryption key.
export function serviceCredentialFingerprint(auth) {
  if (!auth || typeof auth.clientId !== 'string' || !auth.clientId || typeof auth.clientSecret !== 'string' || !auth.clientSecret) throw fail('credential_missing');
  return createHash('sha256').update(`${auth.clientId}\0${auth.clientSecret}`, 'utf8').digest('hex');
}

export function pairKeyFingerprint(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('invalid_pair_key');
  return createHash('sha256').update(key).digest('hex');
}
