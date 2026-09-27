import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyPrompt, buildOrganizationPrompt, CARD_SCHEMA, COMPANY_SCHEMA, organizeWithGemini } from '../src/gemini.mjs';

test('AIプロンプトは捏造禁止、重要情報保持、意味単位分割、既存カテゴリー限定を明示する', () => {
  const prompt = buildOrganizationPrompt('一次面接は9月26日14時', [{ id: 'cat-1', name: '面接' }]);
  for (const phrase of ['元情報にない事実', '日付', '文字数ではなく', '新規カテゴリーを作らない', 'cat-1: 面接', '一次面接は9月26日14時']) {
    assert.match(prompt, new RegExp(phrase));
  }
});

test('Structured Outputはcards配列と必要な3項目を要求する', () => {
  assert.equal(CARD_SCHEMA.properties.cards.type, 'array');
  assert.deepEqual(CARD_SCHEMA.properties.cards.items.required, ['title', 'body', 'categoryIds']);
  assert.equal(CARD_SCHEMA.properties.cards.items.properties.categoryIds.maxItems, 3);
});

test('企業AIは元情報だけを使い、企業名・URL・企業情報を確認用下書きとして返す', () => {
  const prompt = buildCompanyPrompt('A社は採用サイトで事業内容を公開している');
  assert.match(prompt, /元情報にある事実だけ/);
  assert.match(prompt, /A社は採用サイト/);
  assert.deepEqual(COMPANY_SCHEMA.required, ['name', 'url', 'info']);
});

test('Gemini応答が700文字を超えると保存用の案として返さない', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cards: [{ title: '長文', body: 'あ'.repeat(701), categoryIds: [] }] }) }] } }] }) });
  try {
    await assert.rejects(organizeWithGemini({ originalText: '元情報', categories: [], apiKey: 'test-key' }), /700文字/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
