import { EMPTY_STATE } from './store.mjs';

const STATE_PATH = 'app-data.json';

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
      this.#state = current;
      return this;
    }

    const empty = structuredClone(EMPTY_STATE);
    await this.#write(empty);
    this.#state = empty;
    return this;
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  async refresh() {
    await this.#writeQueue.catch(() => {});
    const current = await this.#read();
    this.#state = current ?? structuredClone(EMPTY_STATE);
    return this;
  }

  async update(mutator) {
    let result;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      const current = await this.#read();
      const draft = structuredClone(current ?? EMPTY_STATE);
      result = await mutator(draft);
      await this.#write(draft);
      this.#state = draft;
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
    return new Response(result.stream).json();
  }

  async #write(state) {
    return this.#api.put(STATE_PATH, JSON.stringify(state), {
      access: 'private',
      token: this.#token,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
      allowOverwrite: true
    });
  }
}
