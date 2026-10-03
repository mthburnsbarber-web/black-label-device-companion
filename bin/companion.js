#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { MacOSClipboard } from '../native/macos.js';
import { HttpRelayClient } from '../native/http_relay.js';
import { PairwiseAeadCodec } from '../native/aead_codec.js';
import { KeychainProvider } from '../native/keychain.js';
import { FileState } from '../native/state.js';
import { NativeCompanion } from '../native/companion.js';

function validate(config) {
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
  if (!id(config.deviceId) || !Array.isArray(config.pairedDeviceIds) || !config.pairedDeviceIds.length || config.pairedDeviceIds.some(peer => !id(peer) || peer === config.deviceId)) throw new Error('Invalid device identities');
  if (new URL(config.relayUrl).protocol !== 'https:') throw new Error('Relay must use HTTPS');
  if (typeof config.statePath !== 'string' || !config.statePath.startsWith('/')) throw new Error('State path must be absolute');
  if (typeof config.keychain?.clientIdService !== 'string' || typeof config.keychain?.clientSecretService !== 'string' || typeof config.keychain?.pairKeyPrefix !== 'string') throw new Error('Keychain item names required');
  return config;
}

const [mode, configPath] = process.argv.slice(2);
if (!['--check', '--start'].includes(mode) || !configPath) {
  console.log('Usage: node bin/companion.js --check|--start /absolute/path/companion.config.json');
  process.exitCode = 2;
} else {
  const config = validate(JSON.parse(await readFile(configPath, 'utf8')));
  if (process.platform !== 'darwin') throw new Error('This build supports macOS only');
  if (mode === '--check') {
    console.log(JSON.stringify({ configValid: true, deviceId: config.deviceId, relay: new URL(config.relayUrl).origin, pairedDevices: config.pairedDeviceIds.length, clipboardAccessed: false, keychainAccessed: false }));
  } else {
    const keychain = new KeychainProvider();
    const codec = new PairwiseAeadCodec({ deviceId: config.deviceId, keyForPeer: peer => keychain.pairKey(`${config.keychain.pairKeyPrefix}${peer}`) });
    const client = new HttpRelayClient({ deviceId: config.deviceId, baseUrl: config.relayUrl,
      getAuthorization: async () => ({ clientId: await keychain.read(config.keychain.clientIdService), clientSecret: await keychain.read(config.keychain.clientSecretService) }),
      seal: (message, to) => codec.seal(message, to), open: (payload, from) => codec.open(payload, from) });
    const companion = new NativeCompanion({ deviceId: config.deviceId, clipboard: new MacOSClipboard(), client, state: new FileState(config.statePath), pairedDeviceIds: config.pairedDeviceIds, timeoutMs: 5000 });
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const shutdown = () => { companion.stop(); input.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    await companion.start({ consent: true });
    console.log('Companion enabled. Commands: status, send <device-id>, pause, resume, quit. Clipboard content is never printed.');
    for await (const line of input) {
      const [command, target] = line.trim().split(/\s+/);
      try {
        if (command === 'quit') { shutdown(); break; }
        if (command === 'pause') { companion.stop(); console.log('Paused.'); continue; }
        if (command === 'resume') { await companion.start({ consent: true }); console.log('Enabled.'); continue; }
        if (command === 'status') { console.log(JSON.stringify(companion.status())); continue; }
        if (command === 'send') { const result = await companion.sendClipboard(target, { consent: true }); console.log(JSON.stringify({ transferId: result.envelope.id, state: result.receipt.state, attempts: result.attempts })); continue; }
        console.log('Commands: status, send <device-id>, pause, resume, quit');
      } catch (error) { console.error(`Operation failed: ${error.code || error.message}`); }
    }
    shutdown();
  }
}
