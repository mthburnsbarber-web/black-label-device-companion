import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });

// Reads only named, user-provisioned macOS Keychain items when explicitly called.
// Never log the returned value or place it in argv/environment variables.
export class KeychainProvider {
  constructor({ run = runFile, platform = process.platform } = {}) { this.run = run; this.platform = platform; }
  async read(service) {
    if (this.platform !== 'darwin') throw fail('unsupported_platform');
    if (typeof service !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(service)) throw fail('invalid_service');
    try {
      const result = await this.run('security', ['find-generic-password', '-s', service, '-w'], { maxBuffer: 4096 });
      const value = result.stdout.replace(/\r?\n$/, '');
      if (!value) throw fail('credential_missing');
      return value;
    } catch { throw fail('credential_missing'); }
  }
  async pairKey(service) {
    const encoded = await this.read(service);
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw fail('invalid_pair_key');
    return key;
  }
}
