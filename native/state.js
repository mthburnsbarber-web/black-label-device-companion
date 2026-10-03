import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const empty = () => ({ version: 1, nextSequence: 0, inbound: {}, receipts: {}, lastSequence: {} });

// Private companion metadata only: no text, ciphertext, tokens, or keys.
export class FileState {
  constructor(path) { this.path = path; this.value = null; this.pending = Promise.resolve(); }
  async load() {
    if (this.value) return this.value;
    try { this.value = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.value = empty(); }
    if (this.value.version !== 1) throw new Error('unsupported_state_version');
    return this.value;
  }
  update(mutator) {
    const work = this.pending.then(() => this.writeUpdate(mutator));
    this.pending = work.catch(() => {});
    return work;
  }
  async writeUpdate(mutator) {
    const current = await this.load();
    const next = structuredClone(current);
    const result = mutator(next);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, this.path);
    this.value = next;
    return result;
  }
}
