import test from 'node:test';
import assert from 'node:assert/strict';
import { isPastCard, normalizeCardInput, sortPinnedCards } from '../src/domain.mjs';

const state = {
  companies: [{ id: 'company-1', name: 'A社' }],
  categories: [{ id: 'category-1', name: '面接' }],
  cards: []
};

test('カードは複数カテゴリー、任意の日付、保存先を保持する', () => {
  const card = normalizeCardInput({
    title: '一次面接', body: '本文', destination: { type: 'company', companyId: 'company-1' },
    categoryIds: ['category-1', 'category-1'], eventDate: '2026-09-26', pinned: true
  }, state);
  assert.deepEqual(card.categoryIds, ['category-1']);
  assert.deepEqual(card.destination, { type: 'company', companyId: 'company-1' });
  assert.equal(card.eventDate, '2026-09-26');
  assert.equal(card.pinned, true);
  assert.ok(card.pinnedAt);
});

test('手動カードの本文に文字数制限を課さない', () => {
  const body = 'あ'.repeat(50_000);
  const card = normalizeCardInput({ title: '長文', body, destination: { type: 'self' } }, state);
  assert.equal(card.body.length, 50_000);
  assert.equal(card.originalText, null);
  assert.equal(card.isAiGenerated, false);
});

test('今日のカードは過去にならず、前日のカードだけが過去になる', () => {
  assert.equal(isPastCard({ eventDate: '2026-08-30' }, '2026-08-30'), false);
  assert.equal(isPastCard({ eventDate: '2026-08-29' }, '2026-08-30'), true);
  assert.equal(isPastCard({ eventDate: null }, '2026-08-30'), false);
});

test('ピン留めは明示した日付が今日に近い順、日付なしは最後に並ぶ', () => {
  const cards = [
    { id: 'past-old', pinned: true, eventDate: '2026-08-10', updatedAt: '2026-01-01' },
    { id: 'none', pinned: true, eventDate: null, updatedAt: '2026-01-01' },
    { id: 'future-far', pinned: true, eventDate: '2026-09-20', updatedAt: '2026-01-01' },
    { id: 'past-near', pinned: true, eventDate: '2026-08-29', updatedAt: '2026-01-01' },
    { id: 'today', pinned: true, eventDate: '2026-08-30', updatedAt: '2026-01-01' },
    { id: 'not-pinned', pinned: false, eventDate: '2026-08-30', updatedAt: '2026-01-01' }
  ];
  assert.deepEqual(sortPinnedCards(cards, 'nearest', '2026-08-30').map(({ id }) => id), ['today', 'past-near', 'past-old', 'future-far', 'none']);
});

test('ピン留めの新しい順・古い順は作成日時だけを使う', () => {
  const cards = [
    { id: 'first', pinned: true, createdAt: '2026-09-01T00:00:00Z', eventDate: null },
    { id: 'second', pinned: true, createdAt: '2026-09-03T00:00:00Z', eventDate: '2026-01-01' },
    { id: 'third', pinned: true, createdAt: '2026-09-02T00:00:00Z', eventDate: null },
    { id: 'hidden', pinned: false, createdAt: '2026-09-04T00:00:00Z' }
  ];
  assert.deepEqual(sortPinnedCards(cards, 'newest').map(c => c.id), ['second', 'third', 'first']);
  assert.deepEqual(sortPinnedCards(cards, 'oldest').map(c => c.id), ['first', 'third', 'second']);
});

test('AI作成本文だけ700文字を超えると保存できない', () => {
  const input = { title: 'AI', body: 'あ'.repeat(701), destination: { type: 'self' }, isAiGenerated: true, originalText: '元情報' };
  assert.throws(() => normalizeCardInput(input, state), /700文字/);
  assert.equal(normalizeCardInput({ ...input, body: 'あ'.repeat(700) }, state).body.length, 700);
  const created = normalizeCardInput({ ...input, body: '短い本文' }, state);
  assert.equal(normalizeCardInput({ ...created, body: 'あ'.repeat(701) }, state, created).body.length, 701, 'ユーザーによる保存後の手動編集は制限しない');
});

test('存在しない企業やカテゴリーは保存できない', () => {
  assert.throws(() => normalizeCardInput({ title: 'x', body: 'y', destination: { type: 'company', companyId: 'missing' } }, state), /存在する企業/);
  assert.throws(() => normalizeCardInput({ title: 'x', body: 'y', destination: { type: 'other' }, categoryIds: ['missing'] }, state), /存在しないカテゴリー/);
});
