import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlobStore } from '../src/blob-store.mjs';
import { createAppStore } from '../src/create-store.mjs';
import { JsonStore } from '../src/store.mjs';
import { createAppServer } from '../server.mjs';

function mockPrivateBlob() {
  let contents = null;
  const calls = [];
  return {
    calls,
    mutateRemotely(mutator) {
      const state = JSON.parse(contents);
      mutator(state);
      contents = JSON.stringify(state);
    },
    async get(path, options) {
      assert.equal(path, 'app-data.json');
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      assert.equal(options.token, 'test-token');
      calls.push('get');
      if (contents === null) return null;
      return { statusCode: 200, stream: new Response(contents).body };
    },
    async put(path, body, options) {
      assert.equal(path, 'app-data.json');
      assert.equal(options.access, 'private');
      assert.equal(options.token, 'test-token');
      assert.equal(options.contentType, 'application/json');
      assert.equal(options.allowOverwrite, true);
      assert.equal('ifMatch' in options, false);
      calls.push('put');
      contents = body;
      return {};
    }
  };
}

test('保存先はトークンの有無で切り替わり、Vercelでトークンがなければ書き込まない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syukatsu-store-choice-'));
  try {
    const localPath = join(directory, 'local', 'app-data.json');
    const local = await createAppStore({ env: { DATA_FILE: localPath } });
    assert.ok(local instanceof JsonStore);
    await local.update(state => state.categories.push({ id: 'local', name: 'ローカル' }));
    assert.equal(JSON.parse(await readFile(localPath, 'utf8')).categories[0].name, 'ローカル');

    const forbiddenPath = join(directory, 'var', 'task', 'data', 'app-data.json');
    const blob = await createAppStore({
      env: { VERCEL: '1', BLOB_READ_WRITE_TOKEN: 'test-token', DATA_FILE: forbiddenPath },
      blobApi: mockPrivateBlob()
    });
    assert.ok(blob instanceof BlobStore);
    assert.deepEqual(blob.snapshot(), { version: 1, companies: [], categories: [], cards: [] });
    await assert.rejects(stat(forbiddenPath), { code: 'ENOENT' });
    await assert.rejects(createAppStore({ env: { VERCEL: '1', DATA_FILE: forbiddenPath } }), /BLOB_READ_WRITE_TOKEN/);
    await assert.rejects(stat(forbiddenPath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('更新前に最新Blobを読み、allowOverwriteで同じapp-data.jsonへ保存する', async () => {
  const api = mockPrivateBlob();
  const store = await new BlobStore({ api, token: 'test-token' }).init();
  api.mutateRemotely(state => state.categories.push({ id: 'remote', name: '別Functionの変更' }));

  let mutations = 0;
  await store.update(state => {
    mutations++;
    state.cards.push({ id: 'local', title: '今回の変更' });
  });

  assert.equal(mutations, 1);
  assert.deepEqual(store.snapshot().categories.map(c => c.id), ['remote']);
  assert.deepEqual(store.snapshot().cards.map(c => c.id), ['local']);
  const nextRequest = await new BlobStore({ api, token: 'test-token' }).init();
  assert.deepEqual(nextRequest.snapshot(), store.snapshot());
});

test('Blob保存でカードとカテゴリーの作成・編集・削除ができる', async (t) => {
  const api = mockPrivateBlob();
  const store = await new BlobStore({ api, token: 'test-token' }).init();
  const server = createAppServer({ appStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };

  const category = await request('/api/categories', 'POST', { name: '面接' });
  assert.equal(category.status, 201);
  const card = await request('/api/cards', 'POST', {
    title: '一次面接', body: '14時開始', destination: { type: 'self' }, categoryIds: [category.body.id]
  });
  assert.equal(card.status, 201);
  const edited = await request(`/api/cards/${card.body.id}`, 'PATCH', { title: '一次面接 更新' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, '一次面接 更新');
  const deletedCategory = await request(`/api/categories/${category.body.id}`, 'DELETE');
  assert.equal(deletedCategory.status, 200);
  assert.deepEqual(store.snapshot().cards[0].categoryIds, []);
  assert.equal((await request(`/api/cards/${card.body.id}`, 'DELETE')).status, 200);
  assert.deepEqual(store.snapshot().cards, []);
  assert.deepEqual(store.snapshot().categories, []);
  const persisted = await new BlobStore({ api, token: 'test-token' }).init();
  assert.deepEqual(persisted.snapshot(), store.snapshot());
});

test('private Blobの更新を別インスタンスと次のAPIリクエストで読み取れる', async (t) => {
  const api = mockPrivateBlob();
  const firstStore = await new BlobStore({ api, token: 'test-token' }).init();
  const secondStore = await new BlobStore({ api, token: 'test-token' }).init();
  assert.deepEqual(firstStore.snapshot(), { version: 1, companies: [], categories: [], cards: [] });

  await firstStore.update(state => state.categories.push({ id: 'one', name: '面接' }));
  await secondStore.update(state => state.categories.push({ id: 'two', name: '条件' }));
  await firstStore.refresh();
  assert.deepEqual(firstStore.snapshot().categories.map(c => c.id).sort(), ['one', 'two']);

  const firstServer = createAppServer({ appStore: firstStore });
  const secondServer = createAppServer({ appStore: secondStore });
  await Promise.all([firstServer, secondServer].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  t.after(() => Promise.all([firstServer, secondServer].map(server => new Promise(resolve => server.close(resolve)))));
  const firstUrl = `http://127.0.0.1:${firstServer.address().port}`;
  const secondUrl = `http://127.0.0.1:${secondServer.address().port}`;
  const created = await fetch(`${firstUrl}/api/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'テスト企業' }) });
  assert.equal(created.status, 201);
  const nextRequest = await (await fetch(`${secondUrl}/api/data`)).json();
  assert.equal(nextRequest.companies[0].name, 'テスト企業');
  assert.deepEqual(nextRequest.categories.map(c => c.id).sort(), ['one', 'two']);
  assert.ok(api.calls.includes('put'));
});
