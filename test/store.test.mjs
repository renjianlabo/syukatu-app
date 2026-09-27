import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonStore } from '../src/store.mjs';

test('JSONストアは永続化し、失敗した更新後も次の更新を受け付ける', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syukatsu-store-'));
  const path = join(directory, 'data.json');
  const store = await new JsonStore(path).init();
  await store.update((state) => state.categories.push({ id: '1', name: '自由' }));
  await assert.rejects(store.update(() => { throw new Error('意図した失敗'); }));
  await store.update((state) => state.companies.push({ id: '2', name: 'A社' }));
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.categories[0].name, '自由');
  assert.equal(persisted.companies[0].name, 'A社');
});
