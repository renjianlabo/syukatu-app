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
  let revision = 0;
  const calls = [];
  return {
    calls,
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
      if (contents !== null && (!options.allowOverwrite || options.ifMatch !== `etag-${revision}`)) {
        const error = new Error('更新競合');
        error.name = options.ifMatch ? 'BlobPreconditionFailedError' : 'BlobAlreadyExistsError';
        throw error;
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
