import { get, put } from '@vercel/blob';

// Each state write uses an ETag: an old function cannot overwrite a newer claim or journal.
export class BlobTaskStore {
  constructor(client = { get, put }) { this.client = client; }
  path(id) { if (!/^[a-f0-9]{48}$/.test(id || '')) throw new Error('Invalid task ID'); return `reach/tasks/${id}.json`; }
  async load(id) {
    if (!/^[a-f0-9]{48}$/.test(id || '')) return null;
    const result = await this.client.get(this.path(id), { access: 'private', useCache: false, headers: { 'Accept-Encoding': 'identity' } });
    if (!result) return null;
    return { data: await new Response(result.stream).json(), etag: result.blob.etag };
  }
  async save(id, data, etag) {
    const result = await this.client.put(this.path(id), JSON.stringify(data), { access: 'private', addRandomSuffix: false, contentType: 'application/json', ...(etag ? { ifMatch: etag } : { allowOverwrite: false }) });
    return result.etag;
  }
}
