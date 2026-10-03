#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { MacOSClipboard, compiledMacRunner } from '../native/macos.js';
import { HttpRelayClient } from '../native/http_relay.js';
import { PairwiseAeadCodec } from '../native/aead_codec.js';
import { KeychainProvider } from '../native/keychain.js';
import { FileState } from '../native/state.js';
import { NativeCompanion } from '../native/companion.js';
import { CouncilEnrollmentClient, pairKeyFingerprint } from '../native/council_enrollment.js';
import { readHiddenInvitationCode } from '../native/secret_prompt.js';

function validate(config) {
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
  if (!id(config.deviceId) || !Array.isArray(config.pairedDeviceIds) || !config.pairedDeviceIds.length || config.pairedDeviceIds.some(peer => !id(peer) || peer === config.deviceId)) throw new Error('Invalid device identities');
  if (new URL(config.relayUrl).protocol !== 'https:') throw new Error('Relay must use HTTPS');
  if (typeof config.statePath !== 'string' || !config.statePath.startsWith('/')) throw new Error('State path must be absolute');
  if (typeof config.keychain?.clientIdService !== 'string' || typeof config.keychain?.clientSecretService !== 'string' || typeof config.keychain?.pairKeyPrefix !== 'string') throw new Error('Keychain item names required');
  return config;
}

const [mode, configPath, pairingId] = process.argv.slice(2);
if (!['--check', '--start', '--enroll', '--pair-check'].includes(mode) || !configPath) {
  console.log('Usage: node bin/companion.js --check|--start <config> OR --enroll <config> <pairing-id> OR --pair-check <config> <paired-device-id>');
  process.exitCode = 2;
} else {
  const config = validate(JSON.parse(await readFile(configPath, 'utf8')));
  if (process.platform !== 'darwin') throw new Error('This build supports macOS only');
  if (mode === '--check') {
    console.log(JSON.stringify({ configValid: true, deviceId: config.deviceId, relay: new URL(config.relayUrl).origin, pairedDevices: config.pairedDeviceIds.length, compiledHelperConfigured: !!config.macHelperPath, enrollmentVerified: false, hardwareVerified: false, clipboardAccessed: false, keychainAccessed: false }));
  } else if (mode === '--enroll') {
    if (!pairingId) throw new Error('An owner-issued pairing ID is required');
    const code = await readHiddenInvitationCode();
    const keychain = new KeychainProvider();
    const client = new CouncilEnrollmentClient({ relayUrl: config.relayUrl,
      getAuthorization: async () => ({ clientId: await keychain.read(config.keychain.clientIdService), clientSecret: await keychain.read(config.keychain.clientSecretService) }) });
    const result = await client.enrollWithCredentialFingerprint({ pairingId, deviceId: config.deviceId, code });
    console.log(JSON.stringify(result)); // Public comparison fingerprint only; never print credentials or clipboard content.
  } else if (mode === '--pair-check') {
    if (!config.pairedDeviceIds.includes(pairingId)) throw new Error('Device is not in the configured pair list');
    const key = await new KeychainProvider().pairKey(`${config.keychain.pairKeyPrefix}${pairingId}`);
    console.log(JSON.stringify({ deviceId: config.deviceId, pairedDeviceId: pairingId, keyFingerprint: pairKeyFingerprint(key), keyPresent: true, clipboardAccessed: false, networkAccessed: false }));
  } else {
    if (typeof config.macHelperPath !== 'string') throw new Error('A reviewed compiled macOS helper path is required for live start');
    const keychain = new KeychainProvider();
    const codec = new PairwiseAeadCodec({ deviceId: config.deviceId, keyForPeer: peer => keychain.pairKey(`${config.keychain.pairKeyPrefix}${peer}`) });
    const client = new HttpRelayClient({ deviceId: config.deviceId, baseUrl: config.relayUrl,
      getAuthorization: async () => ({ clientId: await keychain.read(config.keychain.clientIdService), clientSecret: await keychain.read(config.keychain.clientSecretService) }),
      seal: (message, to) => codec.seal(message, to), open: (payload, from) => codec.open(payload, from) });
    const companion = new NativeCompanion({ deviceId: config.deviceId, clipboard: new MacOSClipboard({ run: compiledMacRunner(config.macHelperPath) }), client, state: new FileState(config.statePath), pairedDeviceIds: config.pairedDeviceIds, timeoutMs: 5000 });
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const shutdown = async () => { await companion.stop(); input.close(); };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
    await companion.start({ consent: true });
    console.log('Companion enabled. Commands: status, send <device-id>, pause, resume, quit. Clipboard content is never printed.');
    for await (const line of input) {
      const [command, target] = line.trim().split(/\s+/);
      try {
        if (command === 'quit') { await shutdown(); break; }
        if (command === 'pause') { await companion.stop(); console.log('Paused after in-flight transfer settled.'); continue; }
        if (command === 'resume') { await companion.start({ consent: true }); console.log('Enabled.'); continue; }
        if (command === 'status') { console.log(JSON.stringify(companion.status())); continue; }
        if (command === 'send') { const result = await companion.sendClipboard(target, { consent: true }); console.log(JSON.stringify({ transferId: result.envelope.id, state: result.receipt.state, attempts: result.attempts })); continue; }
        console.log('Commands: status, send <device-id>, pause, resume, quit');
      } catch (error) { console.error(`Operation failed: ${error.code || error.message}`); }
    }
    await shutdown();
  }
}
