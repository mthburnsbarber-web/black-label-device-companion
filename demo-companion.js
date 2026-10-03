import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockClipboard } from './core.js';
import { NativeCompanion } from './native/companion.js';
import { FileState } from './native/state.js';
import { memoryRelayPair } from './native/memory_relay.js';

const dir = await mkdtemp(join(tmpdir(), 'blacklabel-demo-'));
const [first, second] = memoryRelayPair('mini', 'laptop');
const mini = new NativeCompanion({ deviceId: 'mini', clipboard: new MockClipboard('Hello from a mock Mac mini.'), client: first, state: new FileState(join(dir, 'mini.json')), pairedDeviceIds: ['laptop'] });
const laptopClipboard = new MockClipboard('');
const laptop = new NativeCompanion({ deviceId: 'laptop', clipboard: laptopClipboard, client: second, state: new FileState(join(dir, 'laptop.json')), pairedDeviceIds: ['mini'] });
try {
  await mini.start({ consent: true }); await laptop.start({ consent: true });
  const result = await mini.sendClipboard('laptop', { consent: true });
  console.log(JSON.stringify({ mockOnly: true, state: result.receipt.state, attempts: result.attempts, targetText: laptopClipboard.snapshot().text }, null, 2));
} finally { mini.stop(); laptop.stop(); await rm(dir, { recursive: true, force: true }); }
