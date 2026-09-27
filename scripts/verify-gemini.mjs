import { organizeWithGemini } from '../src/gemini.mjs';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY を設定してから実行してください。');
  process.exitCode = 1;
} else {
  const categories = [
    { id: 'existing-interview', name: '面接' },
    { id: 'existing-salary', name: '給与' }
  ];
  const result = await organizeWithGemini({
    categories,
    originalText: '一次面接は9月26日14時からオンラインで実施する。必要物は筆記用具。初任給は28万円。',
    signal: AbortSignal.timeout(60_000)
  });

  if (!Array.isArray(result.cards) || result.cards.length < 2) {
    throw new Error('確認目的の異なる面接情報と給与情報が、独立した複数カードになっていません。');
  }
  const combined = result.cards.map((card) => `${card.title}\n${card.body}`).join('\n');
  const requiredFacts = [
    ['9月26', '9/26'],
    ['14時'],
    ['オンライン'],
    ['筆記用具'],
    ['28万円', '280,000円', '280000円']
  ];
  for (const alternatives of requiredFacts) {
    if (!alternatives.some((fact) => combined.includes(fact))) {
      throw new Error(`重要情報が整理結果に保持されていません: ${alternatives.join(' / ')}`);
    }
  }
  const allowedIds = new Set(categories.map(({ id }) => id));
  if (result.cards.some((card) => card.categoryIds.length > 3 || card.categoryIds.some((id) => !allowedIds.has(id)))) {
    throw new Error('既存カテゴリー以外のID、または4件以上のカテゴリーが返されました。');
  }

  console.log(`Gemini実通信確認成功: ${result.cards.length}枚のカードを生成し、重要情報とカテゴリーIDを検証しました。`);
}
