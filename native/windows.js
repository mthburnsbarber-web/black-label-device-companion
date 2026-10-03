import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MAX_BYTES } from '../core.js';

const fail = code => Object.assign(new Error(code), { code });
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Deliberately requires an externally built helper path. Importing or
// constructing this adapter never starts a process or reads the clipboard.
export function windowsRunner(helperPath, { spawnProcess = spawn } = {}) {
  if (typeof helperPath !== 'string' || !/^[a-zA-Z]:\\/.test(helperPath)) throw fail('invalid_helper_path');
  return (args, input = Buffer.alloc(0), signal) => new Promise((resolve, reject) => {
    const child = spawnProcess(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    const abort = () => child.kill('SIGKILL');
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', bytes => out.push(bytes));
    child.stderr.on('data', bytes => err.push(bytes));
    child.on('error', reject);
    child.on('close', code => { signal?.removeEventListener('abort', abort); if (signal?.aborted) reject(fail('native_helper_timeout')); else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class WindowsClipboard {
  constructor({ run, helperPath, platform = process.platform, helperTimeoutMs = 10_000 } = {}) {
    if (!Number.isSafeInteger(helperTimeoutMs) || helperTimeoutMs < 1 || helperTimeoutMs > 30_000) throw fail('invalid_helper_timeout');
    this.run = run || (helperPath ? windowsRunner(helperPath) : null);
    this.platform = platform; this.helperTimeoutMs = helperTimeoutMs; this.enabled = false; this.lastWrite = null;
  }
  capabilities() { return { clipboardText: this.platform === 'win32' && !!this.run, enabled: this.enabled, inputControl: false }; }
  activate({ consent } = {}) {
    if (this.platform !== 'win32') throw fail('unsupported_platform');
    if (!this.run) throw fail('helper_required');
    if (consent !== true) throw fail('consent_required');
    this.enabled = true;
  }
  pause() { this.enabled = false; this.lastWrite = null; }
  async call(args, input) {
    if (!this.enabled) throw fail('paused');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.helperTimeoutMs);
    let result;
    try {
      result = await Promise.race([
        this.run(args, input, controller.signal),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(fail('native_helper_timeout')), { once: true })),
      ]);
    } catch (error) { throw fail(error.code === 'native_helper_timeout' ? 'native_helper_timeout' : 'native_adapter_failed'); }
    finally { clearTimeout(timer); }
    let body;
    try { body = JSON.parse(result.stdout); } catch { throw fail(result.code ? 'native_adapter_failed' : 'invalid_native_response'); }
    if (result.code !== 0 || body.error) throw fail(body.error || 'native_adapter_failed');
    return body;
  }
  async snapshot() {
    const body = await this.call(['read']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 1 || typeof body.contentBase64 !== 'string') throw fail('invalid_native_response');
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.toString('base64') !== body.contentBase64 || bytes.length > MAX_BYTES) throw fail('invalid_native_response');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('invalid_utf8'); }
    if (text.includes('\0')) throw fail('unsupported_clipboard_text');
    const origin = this.lastWrite?.revision === body.revision && this.lastWrite.sha256 === digest(text) ? this.lastWrite.origin : null;
    return { text, revision: body.revision, origin };
  }
  async compareAndWrite(expectedRevision, text, origin) {
    if (!this.enabled) throw fail('paused');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 0xffffffff || typeof text !== 'string' || text.includes('\0')) throw fail('invalid_arguments');
    const bytes = Buffer.from(text, 'utf8');
    if (!bytes.length || bytes.length > MAX_BYTES) throw fail('invalid_size');
    const body = await this.call(['write', String(expectedRevision)], bytes);
    // A 32-bit clipboard sequence can wrap; equality is the real freshness
    // condition, so never infer ordering from the returned value.
    if (!Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision > 0xffffffff || body.revision === expectedRevision) throw fail('invalid_native_response');
    this.lastWrite = { revision: body.revision, sha256: digest(text), origin };
    return body.revision;
  }
}
