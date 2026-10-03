const MAX_BODY = 256 * 1024;
const MAX_PAYLOAD = 220 * 1024;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);

function decode64(value) {
  const value64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(value64.padEnd(Math.ceil(value64.length / 4) * 4, '='));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

export async function verifyDeviceAccess(request, env, deviceId, fetcher = fetch) {
  const team = env.ACCESS_TEAM_DOMAIN, audiences = JSON.parse(env.DEVICE_AUDIENCES_JSON || '{}');
  const audience = audiences[deviceId];
  if (!team || !audience || audience.startsWith('REPLACE_') || !validId(deviceId) || Object.values(audiences).filter(value => value === audience).length !== 1) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  const pieces = token.split('.'); if (pieces.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(decode64(pieces[0])));
    const body = JSON.parse(new TextDecoder().decode(decode64(pieces[1])));
    if (header.alg !== 'RS256' || !header.kid || body.iss !== `https://${team}` || !Array.isArray(body.aud) || !body.aud.includes(audience)) return false;
    const now = Date.now() / 1000;
    if (!Number.isFinite(body.exp) || body.exp <= now || (body.nbf && body.nbf > now)) return false;
    const certs = await fetcher(`https://${team}/cdn-cgi/access/certs`);
    if (!certs.ok) return false;
    const jwk = (await certs.json()).keys?.find(key => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(pieces[2]), new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`));
  } catch { return false; }
}

export class D1FrameStore {
  constructor(db) { this.db = db; }
  async put(frame) {
    const result = await this.db.prepare('INSERT INTO relay_frames(from_device,to_device,payload,expires_at) VALUES(?,?,?,?)').bind(frame.from, frame.to, frame.payload, frame.expiresAt).run();
    return result.meta.last_row_id;
  }
  async list(to, after, now) {
    const result = await this.db.prepare('SELECT seq,from_device AS "from",payload,expires_at AS expiresAt FROM relay_frames WHERE to_device=? AND seq>? AND expires_at>? ORDER BY seq LIMIT 100').bind(to, after, now).all();
    return result.results;
  }
  async prune(now) { await this.db.prepare('DELETE FROM relay_frames WHERE expires_at<=?').bind(now).run(); }
}

export async function handleRelay(request, env, { authenticate = verifyDeviceAccess, store = new D1FrameStore(env.RELAY_DB), now = Date.now } = {}) {
  if (!env.RELAY_DB || !env.ACCESS_TEAM_DOMAIN || !env.DEVICE_AUDIENCES_JSON || !env.PAIRED_DEVICES_JSON) return json({ error: 'not_configured' }, 503);
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/devices\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/(health|frames)$/);
  if (!match) return json({ error: 'not_found' }, 404);
  const [, deviceId, route] = match;
  if (!(await authenticate(request, env, deviceId))) return json({ error: 'unauthorized' }, 401);
  const pairs = JSON.parse(env.PAIRED_DEVICES_JSON);
  if (!Array.isArray(pairs[deviceId])) return json({ error: 'unpaired_device' }, 403);
  if (route === 'health' && request.method === 'GET') return json({ ok: true });
  if (route !== 'frames') return json({ error: 'not_found' }, 404);
  const timestamp = now();
  await store.prune(timestamp);
  if (request.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0) return json({ error: 'invalid_cursor' }, 400);
    return json({ frames: await store.list(deviceId, after, timestamp) });
  }
  if (request.method === 'POST') {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!validId(body.to) || !pairs[deviceId].includes(body.to) || typeof body.payload !== 'string' || !body.payload || body.payload.length > MAX_PAYLOAD || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= timestamp || body.expiresAt > timestamp + 30_000) return json({ error: 'invalid_frame' }, 400);
    const seq = await store.put({ from: deviceId, to: body.to, payload: body.payload, expiresAt: body.expiresAt });
    return json({ seq }, 202);
  }
  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  fetch(request, env) { return handleRelay(request, env); },
  async scheduled(_event, env) { if (env.RELAY_DB) await new D1FrameStore(env.RELAY_DB).prune(Date.now()); }
};
