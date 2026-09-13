import { mkdir, open, rename, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

// One local server owns each port's journal. Never store provider credentials here.
export class TaskStore {
  constructor(directory, binding) { this.directory = directory; this.binding = binding; }
  path(id) { if (!/^[a-f0-9]{48}$/.test(id)) throw new Error('Invalid task identifier'); return join(this.directory, `${id}.json`); }
  async save(id, snapshot) {
    const path = this.path(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temp = `${path}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, binding: this.binding, snapshot })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async load(id) {
    if (!/^[a-f0-9]{48}$/.test(id || '')) return null;
    let data;
    try { data = JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (data.version !== 1 || data.binding !== this.binding) throw new Error('Saved task belongs to a different connection. Restore that connection before continuing.');
    return data.snapshot;
  }
}
