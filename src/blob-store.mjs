import { EMPTY_STATE } from './store.mjs';

const STATE_PATH = 'app-data.json';
const MAX_WRITE_ATTEMPTS = 5;

export class BlobStore {
  #api;
  #token;
  #state;
  #writeQueue = Promise.resolve();

  constructor({ api, token }) {
    this.#api = api;
    this.#token = token;
  }

  async init() {
    const current = await this.#read();
    if (current) {
      this.#state = current.state;
      return this;
    }

    const empty = structuredClone(EMPTY_STATE);
    try {
      await this.#write(empty);
      this.#state = empty;
    } catch (error) {
      // Another function may have created the initial blob at the same time.
      const created = await this.#read();
      if (!created) throw error;
      this.#state = created.state;
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  async refresh() {
    await this.#writeQueue.catch(() => {});
    const current = await this.#read();
    this.#state = current?.state ?? structuredClone(EMPTY_STATE);
    return this;
  }

  async update(mutator) {
    let result;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const current = await this.#read();
        const draft = structuredClone(current?.state ?? EMPTY_STATE);
        const candidate = await mutator(draft);
        try {
          await this.#write(draft, current?.etag);
          this.#state = draft;
          result = candidate;
          return;
        } catch (error) {
          if (error.name === 'BlobPreconditionFailedError') continue;
          if (!current && await this.#read()) continue;
          throw error;
        }
      }
      const error = new Error('同時更新が続いています。もう一度お試しください。');
      error.status = 409;
      throw error;
    });
    await this.#writeQueue;
    return structuredClone(result);
  }

  async #read() {
    const result = await this.#api.get(STATE_PATH, {
      access: 'private',
      token: this.#token,
      useCache: false
    });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new Error('Blobの保存データを読み取れませんでした。');
    return {
      state: await new Response(result.stream).json(),
      etag: result.blob.etag
    };
  }

  async #write(state, etag) {
    return this.#api.put(STATE_PATH, JSON.stringify(state), {
      access: 'private',
      token: this.#token,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
      ...(etag ? { allowOverwrite: true, ifMatch: etag } : {})
    });
  }
}
