import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { MAX_BYTES } from '../core.js';

const script = fileURLToPath(new URL('./macos_clipboard.swift', import.meta.url));
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const error = code => Object.assign(new Error(code), { code });

// Injectable process boundary. No subprocess is started on import or construction.
function runProcess(executable, args, input = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', cause => { clearTimeout(timer); reject(cause); });
    child.on('close', code => { clearTimeout(timer); if (timedOut) reject(error('native_helper_timeout')); else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function swiftRunner(args, input) { return runProcess('swift', [script, ...args], input); }
export function compiledMacRunner(helperPath) {
  if (typeof helperPath !== 'string' || !isAbsolute(helperPath)) throw error('invalid_helper_path');
  return (args, input) => runProcess(helperPath, args, input);
}

export class MacOSClipboard {
  constructor({ run = swiftRunner, platform = process.platform } = {}) {
    this.run = run; this.platform = platform; this.enabled = false; this.lastWrite = null;
  }
  capabilities() { return { clipboardText: this.platform === 'darwin', enabled: this.enabled, inputControl: false }; }
  activate({ consent } = {}) { if (this.platform !== 'darwin') throw error('unsupported_platform'); if (consent !== true) throw error('consent_required'); this.enabled = true; }
  pause() { this.enabled = false; this.lastWrite = null; }
  assertEnabled() { if (!this.enabled) throw error('paused'); }
  async call(args, input) {
    this.assertEnabled();
    const result = await this.run(args, input);
    let body;
    try { body = JSON.parse(result.stdout); } catch { throw error(result.code ? 'native_adapter_failed' : 'invalid_native_response'); }
    if (result.code !== 0 || body.error) throw error(body.error || 'native_adapter_failed');
    return body;
  }
  async snapshot() {
    const body = await this.call(['read']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.contentBase64 !== 'string') throw error('invalid_native_response');
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.toString('base64') !== body.contentBase64) throw error('invalid_native_response');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error('invalid_utf8'); }
    const origin = this.lastWrite?.revision === body.revision && this.lastWrite.sha256 === digest(text) ? this.lastWrite.origin : null;
    return { text, revision: body.revision, origin };
  }
  async compareAndWrite(expectedRevision, text, origin) {
    this.assertEnabled();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof text !== 'string') throw error('invalid_arguments');
    const bytes = Buffer.from(text, 'utf8');
    if (!bytes.length || bytes.length > MAX_BYTES) throw error('invalid_size');
    const body = await this.call(['write', String(expectedRevision)], bytes);
    if (!Number.isSafeInteger(body.revision) || body.revision <= expectedRevision) throw error('invalid_native_response');
    this.lastWrite = { revision: body.revision, sha256: digest(text), origin };
    return body.revision;
  }
}
