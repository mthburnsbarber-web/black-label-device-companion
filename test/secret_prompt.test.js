import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readHiddenInvitationCode } from '../native/secret_prompt.js';

function terminal() {
  const input = new PassThrough(); const output = new PassThrough();
  let shown = '';
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = enabled => { input.isRaw = enabled; };
  output.on('data', chunk => { shown += chunk.toString(); });
  return { input, output, shown: () => shown };
}

test('invitation code is accepted without echo and raw mode is restored', async () => {
  const t = terminal(); const pending = readHiddenInvitationCode(t.input, t.output);
  t.input.write(`${'a'.repeat(42)}b\r`);
  assert.equal(await pending, `${'a'.repeat(42)}b`);
  assert.equal(t.input.isRaw, false);
  assert.equal(t.shown().includes('a'.repeat(42)), false);
});

test('invalid and cancelled invitations fail closed', async () => {
  const t = terminal(); const invalid = readHiddenInvitationCode(t.input, t.output);
  t.input.write('short\r');
  await assert.rejects(invalid, { code: 'invalid_invitation' });
  const cancelled = readHiddenInvitationCode(t.input, t.output);
  t.input.write(Buffer.from([3]));
  await assert.rejects(cancelled, { code: 'cancelled' });
  assert.equal(t.input.isRaw, false);
});

test('noninteractive input is not accepted', async () => {
  await assert.rejects(readHiddenInvitationCode(new PassThrough(), new PassThrough()), { code: 'interactive_terminal_required' });
});
