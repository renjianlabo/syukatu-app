import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { BlobStore } from '../src/blob-store.mjs';
import { createAppStore } from '../src/create-store.mjs';
import { JsonStore } from '../src/store.mjs';
import { createAppServer } from '../server.mjs';

function mockPrivateBlob() {
  let contents = null;
  let revision = 0;
  let conflictsRemaining = 0;
  let concurrentMutation = () => {};
  const calls = [];
  return {
    calls,
    forceConflicts(count, mutate = () => {}) {
      conflictsRemaining = count;
      concurrentMutation = mutate;
    },
    async get(path, options) {
      assert.equal(path, 'app-data.json');
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      assert.equal(options.token, 'test-token');
      calls.push('get');
      if (contents === null) return null;
      return { statusCode: 200, stream: new Response(contents).body, blob: { etag: `etag-${revision}` } };
    },
    async put(path, body, options) {
      assert.equal(path, 'app-data.json');
      assert.equal(options.access, 'private');
      assert.equal(options.token, 'test-token');
      assert.equal(options.contentType, 'application/json');
      calls.push('put');
      if (options.ifMatch && conflictsRemaining > 0) {
        conflictsRemaining--;
        const concurrent = JSON.parse(contents);
        concurrentMutation(concurrent);
        contents = JSON.stringify(concurrent);
        revision++;
        throw new BlobPreconditionFailedError();
      }
      if (contents !== null && (!options.allowOverwrite || options.ifMatch !== `etag-${revision}`)) {
        if (options.ifMatch) throw new BlobPreconditionFailedError();
        throw new Error('BlobAlreadyExistsError');
      }
      contents = body;
      revision++;
      return { etag: `etag-${revision}` };
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

test('ETag競合後は最新Blobを読み直し、mutatorを再適用して保存する', async () => {
  const api = mockPrivateBlob();
  const store = await new BlobStore({ api, token: 'test-token' }).init();
  api.forceConflicts(1, state => state.categories.push({ id: 'remote', name: '別Functionの変更' }));

  let mutations = 0;
  await store.update(state => {
    mutations++;
    state.cards.push({ id: 'local', title: '今回の変更' });
  });

  assert.equal(mutations, 2);
  assert.deepEqual(store.snapshot().categories.map(c => c.id), ['remote']);
  assert.deepEqual(store.snapshot().cards.map(c => c.id), ['local']);
  const nextRequest = await new BlobStore({ api, token: 'test-token' }).init();
  assert.deepEqual(nextRequest.snapshot(), store.snapshot());
});

test('ETag競合が5回続いた場合だけ409を返す', async () => {
  const api = mockPrivateBlob();
  const store = await new BlobStore({ api, token: 'test-token' }).init();
  api.forceConflicts(5);

  let mutations = 0;
  await assert.rejects(store.update(state => {
    mutations++;
    state.cards.push({ id: 'unsaved' });
  }), error => error.status === 409);

  assert.equal(mutations, 5);
  assert.deepEqual(store.snapshot().cards, []);
});

test('POST /api/cards は競合を再試行し、5回続いた場合はHTTP 409を返す', async (t) => {
  const api = mockPrivateBlob();
  const store = await new BlobStore({ api, token: 'test-token' }).init();
  const server = createAppServer({ appStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/cards`;
  const save = title => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body: '本文', destination: { type: 'self' } })
  });

  api.forceConflicts(1);
  const saved = await save('保存成功');
  assert.equal(saved.status, 201);
  assert.equal(store.snapshot().cards.length, 1);

  api.forceConflicts(5);
  const conflict = await save('未保存');
  assert.equal(conflict.status, 409);
  assert.equal(store.snapshot().cards.length, 1);
});

test('private Blobの更新を別インスタンスと次のAPIリクエストで読み取れる', async (t) => {
  const api = mockPrivateBlob();
  const firstStore = await new BlobStore({ api, token: 'test-token' }).init();
  const secondStore = await new BlobStore({ api, token: 'test-token' }).init();
  assert.deepEqual(firstStore.snapshot(), { version: 1, companies: [], categories: [], cards: [] });

  await Promise.all([
    firstStore.update(state => state.categories.push({ id: 'one', name: '面接' })),
    secondStore.update(state => state.categories.push({ id: 'two', name: '条件' }))
  ]);
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
