import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonStore } from '../src/store.mjs';
import { createAppServer } from '../server.mjs';

test('REST APIで企業・カテゴリー・カード・AI下書きの一連の操作ができる', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'syukatsu-api-'));
  const appStore = await new JsonStore(join(directory, 'data.json')).init();
  let organizerInput;
  let cancelObservedResolve;
  const cancelObserved = new Promise((resolve) => { cancelObservedResolve = resolve; });
  const organizer = async ({ originalText, categories, signal }) => {
    if (originalText === 'キャンセル確認') {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        cancelObservedResolve();
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true }));
    }
    organizerInput = { originalText, categories };
    return { cards: [{ title: '整理結果', body: '重要事項を保持した本文', categoryIds: categories.map(({ id }) => id) }] };
  };
  const companyOrganizer = async ({ originalText }) => ({ name: 'AI企業', url: 'https://example.com', info: `${originalText}を整理` });
  const server = createAppServer({ appStore, organizer, companyOrganizer });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const request = async (path, options = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json();
    return { status: response.status, payload };
  };

  const company = (await request('/api/companies', { method: 'POST', body: { name: 'A社' } })).payload;
  const category = (await request('/api/categories', { method: 'POST', body: { name: '面接' } })).payload;
  assert.ok(company.id);
  assert.equal(company.url, undefined);
  assert.equal(company.info, undefined);
  assert.ok(category.id);

  const longBody = 'a'.repeat(5_100_000);
  const created = await request('/api/cards', {
    method: 'POST',
    body: {
      title: '長文カード', body: longBody,
      destination: { type: 'company', companyId: company.id },
      categoryIds: [category.id], eventDate: '2099-09-26', pinned: true
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.body.length, longBody.length, '5MBを超える手動本文も省略しない');

  const updatedCompany = await request(`/api/companies/${company.id}`, { method: 'PATCH', body: { name: 'A社 更新', info: '更新後' } });
  assert.equal(updatedCompany.status, 200);
  assert.equal(updatedCompany.payload.name, 'A社 更新');
  assert.equal(updatedCompany.payload.info, '更新後');

  const updated = await request(`/api/cards/${created.payload.id}`, {
    method: 'PATCH',
    body: { title: '更新後タイトル', pinned: false }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.title, '更新後タイトル');
  assert.equal(updated.payload.pinned, false);

  const aiCountBefore = appStore.snapshot().cards.length;
  const drafts = await request('/api/ai/organize', { method: 'POST', body: { originalText: '9月26日に一次面接' } });
  assert.equal(drafts.status, 200);
  assert.equal(drafts.payload.cards[0].title, '整理結果');
  assert.equal(organizerInput.originalText, '9月26日に一次面接');
  assert.deepEqual(organizerInput.categories.map(({ id }) => id), [category.id]);
  assert.equal(appStore.snapshot().cards.length, aiCountBefore, 'AI結果は確認前に正式保存しない');

  const urlDraft = await request('/api/ai/organize', { method: 'POST', body: { sourceUrl: `${origin}/` } });
  assert.equal(urlDraft.status, 200);
  assert.match(organizerInput.originalText, /就活ノート/, 'URLの文章をAI整理へ渡す');

  const companyCountBefore = appStore.snapshot().companies.length;
  const companyDraft = await request('/api/ai/organize-company', { method: 'POST', body: { originalText: '会社説明会の記録' } });
  assert.equal(companyDraft.status, 200);
  assert.equal(companyDraft.payload.name, 'AI企業');
  assert.equal(appStore.snapshot().companies.length, companyCountBefore, '企業AI結果も確認前に正式保存しない');

  const batch = await request('/api/cards/batch', {
    method: 'POST',
    body: { cards: [{
      title: '確認済みAIカード', body: '確認後の本文', destination: { type: 'self' },
      categoryIds: [category.id], isAiGenerated: true, originalText: '整理前の全文'
    }, {
      title: '二枚目', body: '二枚目の本文', destination: { type: 'self' },
      categoryIds: [], isAiGenerated: true, originalText: '整理前の全文'
    }] }
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.payload.cards.length, 2);
  assert.equal(batch.payload.cards[0].originalText, '整理前の全文');
  assert.equal(batch.payload.cards[0].isAiGenerated, true);

  const beforeFailedBatch = appStore.snapshot().cards.length;
  const failedBatch = await request('/api/cards/batch', { method: 'POST', body: { cards: [
    { title: '保存されない一枚目', body: '本文', destination: { type: 'self' }, isAiGenerated: true },
    { title: '二枚目は不正', body: '', destination: { type: 'self' }, isAiGenerated: true }
  ] } });
  assert.equal(failedBatch.status, 400);
  assert.equal(appStore.snapshot().cards.length, beforeFailedBatch, '一枚でも不正なら全件保存しない');

  const otherCategory = (await request('/api/categories', { method: 'POST', body: { name: '面接' } })).payload;
  assert.notEqual(otherCategory.id, category.id, '同名カテゴリーも別IDとして作成できる');
  await request(`/api/cards/${created.payload.id}`, { method: 'PATCH', body: { categoryIds: [category.id, otherCategory.id] } });
  const categoryDelete = await request(`/api/categories/${category.id}`, { method: 'DELETE' });
  assert.equal(categoryDelete.status, 200);
  assert.ok(appStore.snapshot().cards.every((card) => !card.categoryIds.includes(category.id)));
  assert.deepEqual(appStore.snapshot().cards.find(card => card.id === created.payload.id).categoryIds, [otherCategory.id], '他のカテゴリーとの紐付けは維持');
  assert.equal((await request(`/api/categories/${otherCategory.id}`, { method: 'DELETE' })).status, 200);

  const controller = new AbortController();
  const cancellingRequest = fetch(`${origin}/api/ai/organize`, {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalText: 'キャンセル確認' })
  }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await cancellingRequest;
  await Promise.race([cancelObserved, new Promise((_, reject) => setTimeout(() => reject(new Error('サーバー側キャンセルが観測されませんでした')), 2_000))]);

  assert.equal((await request(`/api/companies/${company.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!appStore.snapshot().cards.some((card) => card.id === created.payload.id), '企業削除時は関連情報も削除する');

  const data = (await request('/api/data')).payload;
  assert.equal(data.companies.length, 0);
  assert.equal(data.categories.length, 0);
  assert.equal(data.cards.length, 2);
  assert.equal(data.cards[0].title, '確認済みAIカード');
});
