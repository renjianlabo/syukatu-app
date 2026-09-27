import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const EMPTY_STATE = Object.freeze({ version: 1, companies: [], categories: [], cards: [] });

export class JsonStore {
  #filePath;
  #state;
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    this.#filePath = filePath;
  }

  async init() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    try {
      this.#state = JSON.parse(await readFile(this.#filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  async update(mutator) {
    let result;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      const draft = structuredClone(this.#state);
      result = await mutator(draft);
      await this.#persist(draft);
      this.#state = draft;
    });
    await this.#writeQueue;
    return structuredClone(result);
  }

  async #persist(state = this.#state) {
    const temporaryPath = `${this.#filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.#filePath);
  }
}
