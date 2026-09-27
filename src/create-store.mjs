import { fileURLToPath } from 'node:url';
import { BlobStore } from './blob-store.mjs';
import { JsonStore } from './store.mjs';

const DEFAULT_DATA_FILE = fileURLToPath(new URL('../data/app-data.json', import.meta.url));

export async function createAppStore({ env = process.env, blobApi } = {}) {
  if (env.BLOB_READ_WRITE_TOKEN) {
    const api = blobApi ?? await import('@vercel/blob');
    return new BlobStore({ api, token: env.BLOB_READ_WRITE_TOKEN }).init();
  }
  if (env.VERCEL) {
    throw new Error('Vercelではprivate Blob StoreとBLOB_READ_WRITE_TOKENの設定が必要です。');
  }
  return new JsonStore(env.DATA_FILE || DEFAULT_DATA_FILE).init();
}
