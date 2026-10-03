import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const MAX_FRAME = 256 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };

// Loopback-only integration harness. Not a production identity or cloud service.
export class LoopbackHttpRelay {
  constructor(tokenByDevice) { this.tokens = new Map(Object.entries(tokenByDevice)); this.messages = new Map(); this.acknowledged = new Set(); this.sequence = 0; this.server = null; }
  authenticate(request) {
    const id = request.headers['x-device-id'];
    const expected = this.tokens.get(id);
    const supplied = request.headers.authorization?.replace(/^Bearer /, '');
    if (!expected || !supplied || !validId(id)) return null;
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b) ? id : null;
  }
  async start() {
    if (this.server) throw fail('already_started');
    this.server = createServer(async (request, response) => {
      const deviceId = this.authenticate(request);
      if (!deviceId) return json(response, 401, { error: 'unauthorized' });
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/frames') {
        const after = Number(url.searchParams.get('after')) || 0;
        if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { error: 'invalid_cursor' });
        const now = Date.now();
        const frames = (this.messages.get(deviceId) || []).filter(x => x.seq > after && x.expiresAt > now).slice(0, 100);
        return json(response, 200, { frames });
      }
      const ack = url.pathname.match(/^\/frames\/([1-9][0-9]*)\/ack$/);
      if (request.method === 'POST' && ack) {
        const seq = Number(ack[1]);
        const owned = (this.messages.get(deviceId) || []).some(frame => frame.seq === seq);
        if (!owned) return json(response, 404, { error: 'unknown_frame' });
        this.acknowledged.add(seq);
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/frames') {
        let size = 0, chunks = [];
        for await (const chunk of request) {
          size += chunk.length; if (size > MAX_FRAME) return json(response, 413, { error: 'too_large' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(response, 400, { error: 'invalid_json' }); }
        if (!validId(body.to) || !this.tokens.has(body.to) || typeof body.payload !== 'string' || body.payload.length > MAX_FRAME || body.payload.length < 1 || !Number.isFinite(body.expiresAt) || body.expiresAt < Date.now() || body.expiresAt > Date.now() + 30_000) return json(response, 400, { error: 'invalid_frame' });
        const frame = { seq: ++this.sequence, from: deviceId, payload: body.payload, expiresAt: body.expiresAt };
        const list = this.messages.get(body.to) || [];
        list.push(frame);
        this.messages.set(body.to, list.filter(x => x.expiresAt > Date.now()).slice(-1000));
        return json(response, 202, { seq: frame.seq });
      }
      return json(response, 404, { error: 'not_found' });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${this.server.address().port}`;
  }
  async stop() { if (!this.server) return; await new Promise(resolve => this.server.close(resolve)); this.server = null; }
}

export class HttpRelayClient {
  constructor({ deviceId, baseUrl, getAuthorization, seal, open, fetcher = fetch, pollMs = 1000, requestTimeoutMs = 5000, allowLoopback = false }) {
    const url = new URL(baseUrl);
    const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (!validId(deviceId) || !(url.protocol === 'https:' || (allowLoopback && loopback)) || url.username || url.password || typeof getAuthorization !== 'function' || typeof seal !== 'function' || typeof open !== 'function' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000) throw fail('invalid_configuration');
    this.deviceId = deviceId; this.baseUrl = url.toString().replace(/\/$/, ''); this.getAuthorization = getAuthorization;
    this.seal = seal; this.open = open; this.fetcher = fetcher; this.pollMs = pollMs; this.requestTimeoutMs = requestTimeoutMs;
    this.enabled = false; this.connected = false; this.cursor = 0; this.lastTransportAckSeq = 0; this.pendingAcks = new Set(); this.timer = null; this.onMessage = null; this.authorization = null;
  }
  status() { return { connected: this.connected, enabled: this.enabled, deviceId: this.deviceId, lastTransportAckSeq: this.lastTransportAckSeq, pendingTransportAcks: this.pendingAcks.size }; }
  headers() {
    const identity = typeof this.authorization === 'string'
      ? { authorization: `Bearer ${this.authorization}` }
      : { 'CF-Access-Client-Id': this.authorization.clientId, 'CF-Access-Client-Secret': this.authorization.clientSecret };
    return { 'x-device-id': this.deviceId, ...identity, 'content-type': 'application/json' };
  }
  async start({ consent, onMessage } = {}) {
    if (consent !== true) throw fail('consent_required');
    if (this.enabled && this.connected) throw fail('already_started');
    clearTimeout(this.timer);
    const authorization = await this.getAuthorization(this.deviceId);
    if (!(typeof authorization === 'string' && authorization) && !(authorization && typeof authorization.clientId === 'string' && authorization.clientId && typeof authorization.clientSecret === 'string' && authorization.clientSecret)) throw fail('pairing_required');
    this.authorization = authorization;
    let response;
    try { response = await this.fetcher(`${this.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(this.requestTimeoutMs) }); }
    catch (error) { this.authorization = null; throw error; }
    if (!response.ok) { this.authorization = null; throw fail('unauthorized'); }
    this.enabled = true; this.connected = true; this.onMessage = onMessage;
    this.schedule();
  }
  schedule() {
    if (!this.enabled) return;
    this.timer = setTimeout(async () => { await this.poll().catch(() => { this.connected = false; }); this.schedule(); }, this.pollMs);
  }
  async poll() {
    if (!this.enabled) return;
    for (const seq of [...this.pendingAcks].sort((a, b) => a - b)) await this.acknowledge(seq);
    const response = await this.fetcher(`${this.baseUrl}/frames?after=${this.cursor}`, { headers: this.headers(), signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) throw fail('offline');
    this.connected = true;
    const body = await response.json();
    for (const frame of body.frames || []) {
      if (!Number.isSafeInteger(frame.seq) || frame.seq <= this.cursor) continue;
      const message = await this.open(frame.payload, frame.from);
      await this.onMessage?.({ authenticatedPeerId: frame.from, message });
      this.cursor = frame.seq;
      this.pendingAcks.add(frame.seq);
      await this.acknowledge(frame.seq);
    }
  }
  async acknowledge(seq) {
    const response = await this.fetcher(`${this.baseUrl}/frames/${seq}/ack`, { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) throw fail('transport_ack_failed');
    this.pendingAcks.delete(seq);
    this.lastTransportAckSeq = Math.max(this.lastTransportAckSeq, seq);
  }
  async send(message) {
    if (!this.enabled || !this.connected) throw fail('offline');
    const to = ['receipt', 'prepared'].includes(message.type) ? message.sourceDeviceId : message.targetDeviceId;
    if (!validId(to) || to === this.deviceId) throw fail('invalid_target');
    const payload = await this.seal(message, to);
    if (typeof payload !== 'string' || !payload) throw fail('encryption_failed');
    let response;
    try { response = await this.fetcher(`${this.baseUrl}/frames`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ to, payload, expiresAt: Date.now() + 30_000 }), signal: AbortSignal.timeout(this.requestTimeoutMs) }); }
    catch { this.connected = false; throw fail('offline'); }
    if (!response.ok) { this.connected = false; throw fail('offline'); }
    let body;
    try { body = await response.json(); } catch { throw fail('invalid_relay_response'); }
    if (response.status !== 202 || !Number.isSafeInteger(body.seq) || body.seq < 1) throw fail('invalid_relay_response');
    return { state: 'queued', seq: body.seq };
  }
  stop() { this.enabled = false; this.connected = false; this.onMessage = null; this.authorization = null; clearTimeout(this.timer); this.timer = null; }
}
