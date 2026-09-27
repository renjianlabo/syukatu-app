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

test('ピン留めの日付順は今日・未来、日付なし、過去の順に並ぶ', () => {
  const cards = [
    { id: 'past-yesterday-old', pinned: true, eventDate: '2026-09-27', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'none-old', pinned: true, eventDate: null, createdAt: '2026-09-01T00:00:00Z' },
    { id: 'future-far', pinned: true, eventDate: '2026-10-14', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'past-week-new', pinned: true, eventDate: '2026-09-22', createdAt: '2026-09-12T00:00:00Z' },
    { id: 'today-old', pinned: true, eventDate: '2026-09-28', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'future-same-old', pinned: true, eventDate: '2026-09-30', createdAt: '2026-09-02T00:00:00Z' },
    { id: 'tomorrow', pinned: true, eventDate: '2026-09-29', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'none-new', pinned: true, eventDate: null, createdAt: '2026-09-10T00:00:00Z' },
    { id: 'today-new', pinned: true, eventDate: '2026-09-28', createdAt: '2026-09-10T00:00:00Z' },
    { id: 'past-yesterday-mid', pinned: true, eventDate: '2026-09-27', createdAt: '2026-09-06T00:00:00Z' },
    { id: 'future-same-new', pinned: true, eventDate: '2026-09-30', createdAt: '2026-09-09T00:00:00Z' },
    { id: 'not-pinned', pinned: false, eventDate: '2026-09-28', createdAt: '2026-09-13T00:00:00Z' }
  ];
  const expected = ['today-new', 'today-old', 'tomorrow', 'future-same-new', 'future-same-old', 'future-far', 'none-new', 'none-old', 'past-week-new', 'past-yesterday-mid', 'past-yesterday-old'];
  assert.deepEqual(sortPinnedCards(cards, 'nearest', '2026-09-28').map(({ id }) => id), expected);
  assert.deepEqual(sortPinnedCards(cards, '2026-09-28').map(({ id }) => id), expected, '旧形式の参照日引数も維持');
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
