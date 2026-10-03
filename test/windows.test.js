import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsClipboard, windowsRunner } from '../native/windows.js';

test('Windows adapter stays inert until explicit opt-in and preserves exact text', async () => {
  const calls = [];
  let revision = 42, text = '雪\n🙂';
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'read') return { code: 0, stdout: JSON.stringify({ revision, contentBase64: Buffer.from(text).toString('base64') }) };
    if (Number(args[1]) !== revision) return { code: 3, stdout: JSON.stringify({ error: 'concurrent_change' }) };
    text = input.toString('utf8'); revision++;
    return { code: 0, stdout: JSON.stringify({ revision }) };
  };
  const clipboard = new WindowsClipboard({ run, platform: 'win32' });
  assert.deepEqual(clipboard.capabilities(), { clipboardText: true, enabled: false, inputControl: false });
  await assert.rejects(clipboard.snapshot(), { code: 'paused' });
  assert.equal(calls.length, 0);
  assert.throws(() => clipboard.activate(), { code: 'consent_required' });
  clipboard.activate({ consent: true });
  const before = await clipboard.snapshot();
  assert.equal(before.text, text);
  const next = await clipboard.compareAndWrite(before.revision, 'line one\nline two 🙂', { transferId: 'x' });
  assert.equal(next, 43);
  assert.deepEqual((await clipboard.snapshot()).origin, { transferId: 'x' });
  await assert.rejects(clipboard.compareAndWrite(42, 'stale', null), { code: 'concurrent_change' });
  assert.equal(calls[1].input.toString(), 'line one\nline two 🙂');
  clipboard.pause();
  await assert.rejects(clipboard.snapshot(), { code: 'paused' });
});

test('Windows adapter rejects unsupported platform, missing helper and unsafe text', async () => {
  assert.throws(() => new WindowsClipboard({ platform: 'win32' }).activate({ consent: true }), { code: 'helper_required' });
  assert.throws(() => new WindowsClipboard({ platform: 'darwin', run: () => {} }).activate({ consent: true }), { code: 'unsupported_platform' });
  assert.throws(() => windowsRunner('./relative.exe'), { code: 'invalid_helper_path' });
  const clipboard = new WindowsClipboard({ platform: 'win32', run: async () => ({ code: 0, stdout: '{"revision":1,"contentBase64":""}' }) });
  clipboard.activate({ consent: true });
  await assert.rejects(clipboard.compareAndWrite(1, 'bad\0text'), { code: 'invalid_arguments' });
  await assert.rejects(clipboard.compareAndWrite(1, 'x'.repeat(65537)), { code: 'invalid_size' });
  await assert.rejects(clipboard.snapshot().then(x => clipboard.compareAndWrite(x.revision, 'x')), { code: 'invalid_native_response' });
});

test('Windows adapter surfaces native denial without mutating in JavaScript', async () => {
  const clipboard = new WindowsClipboard({ platform: 'win32', run: async () => ({ code: 2, stdout: '{"error":"permission_denied"}' }) });
  clipboard.activate({ consent: true });
  await assert.rejects(clipboard.snapshot(), { code: 'permission_denied' });
  await assert.rejects(clipboard.compareAndWrite(1, 'x'), { code: 'permission_denied' });
});
