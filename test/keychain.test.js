import test from 'node:test';
import assert from 'node:assert/strict';
import { KeychainProvider } from '../native/keychain.js';

test('keychain provider reads only named items through injected runner', async () => {
  const calls = [];
  const provider = new KeychainProvider({ platform: 'darwin', run: async (command, args) => { calls.push({ command, args }); return { stdout: `${Buffer.alloc(32, 3).toString('base64')}\n` }; } });
  const key = await provider.pairKey('blacklabel-device-pair-laptop');
  assert.equal(key.length, 32);
  assert.deepEqual(calls, [{ command: 'security', args: ['find-generic-password', '-s', 'blacklabel-device-pair-laptop', '-w'] }]);
});

test('keychain provider rejects unsupported platform and malformed item names', async () => {
  const provider = new KeychainProvider({ platform: 'linux', run: () => { throw new Error('must not run'); } });
  await assert.rejects(provider.read('item'), { code: 'unsupported_platform' });
  const mac = new KeychainProvider({ platform: 'darwin', run: () => { throw new Error('must not run'); } });
  await assert.rejects(mac.read('bad item'), { code: 'invalid_service' });
});
