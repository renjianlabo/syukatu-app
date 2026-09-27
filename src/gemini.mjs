const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'categoryIds'],
        properties: {
          title: { type: 'string', description: '単独で意味が分かる日本語のタイトル' },
          body: { type: 'string', description: '単独で理解できる整理済み本文。700文字以内' },
          categoryIds: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string' },
            description: '提示された既存カテゴリーIDのみ。該当しなければ空配列'
          }
        }
      }
    }
  }
};

export const COMPANY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'url', 'info'],
  properties: {
    name: { type: 'string', description: '企業名' },
    url: { type: 'string', description: '元情報に企業URLがあればそのURL。なければ空文字' },
    info: { type: 'string', description: '元情報だけを使って整理した企業情報' }
  }
};

export function buildOrganizationPrompt(originalText, categories) {
  const categoryText = categories.length
    ? categories.map(({ id, name }) => `- ${id}: ${name}`).join('\n')
    : '（カテゴリーなし）';
  return `あなたは就活情報を、後から確認しやすい独立した情報カードへ整理します。

最重要ルール:
- 元情報にある重要な事実、判断、条件を失わない。
- 具体的な日付、締切、時間、金額、場所、応募条件、必要物、決定事項、重要な注意事項を最優先で残す。
- 重要な結論、ユーザー自身の判断・希望・懸念と、その理解に必要な理由を残す。
- 重複、相槌、雑談、不要な前置き、脱線だけを削除・統合する。
- 元情報にない事実、推測、一般論、AIの意見を絶対に追加しない。
- ユーザーの意見と客観的事実を混同しない。不明なことを補完しない。

カード分割:
- 文字数ではなく「同じ目的で一緒に確認したい情報か」で分ける。
- 異なる確認目的は別カードにする。
- 各カードは他カードを読まなくても理解できるタイトルと本文にする。「①」「②」のような依存する分割は禁止。
- 本文は1カード最大700文字。通常は十分短くまとめる。長い場合は重複を削り、簡潔に言い換え、確認目的が異なる場合だけ分割する。重要な事実を削らない。
- タイトルや本文に含まれる日付をカードの日付欄へ自動登録しない。

カテゴリー:
- 下記の既存カテゴリーと内容が明確に一致するときだけ、そのIDを1〜3件選ぶ。
- 新規カテゴリーを作らない。無理に選ばない。IDを名前として出力しない。

既存カテゴリー:
${categoryText}

元情報:
---
${originalText}
---`;
}

export async function organizeWithGemini({ originalText, categories, signal, apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_MODEL }) {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません。'), { status: 503 });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildOrganizationPrompt(originalText, categories) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: CARD_SCHEMA,
        temperature: 0.1
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Gemini APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
  if (!text) throw Object.assign(new Error('Geminiから整理結果を取得できませんでした。'), { status: 502 });

  let parsed;
  try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error('Geminiの応答をJSONとして解釈できませんでした。'), { status: 502 }); }
  const validIds = new Set(categories.map((category) => category.id));
  if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    throw Object.assign(new Error('Geminiの応答にカードが含まれていません。'), { status: 502 });
  }
  const cards = parsed.cards.map((card) => ({
      title: String(card.title ?? '').trim(),
      body: String(card.body ?? '').trim(),
      categoryIds: [...new Set(Array.isArray(card.categoryIds) ? card.categoryIds : [])].filter((id) => validIds.has(id)).slice(0, 3)
    })).filter((card) => card.title && card.body);
  if (!cards.length || cards.some((card) => [...card.body].length > 700)) {
    throw Object.assign(new Error('AIの整理結果が700文字制限を満たしませんでした。再試行してください。'), { status: 502 });
  }
  return { cards };
}

export function buildCompanyPrompt(originalText) {
  return `あなたは就活のために集めた企業情報を、確認しやすい企業ノートへ整理します。

最重要ルール:
- 元情報にある事実だけを使い、推測や一般論を追加しない。
- 企業名、企業URL、事業内容、特徴、選考に関係する情報を読み取る。
- 企業URLが元情報にない場合は空文字にする。
- 企業情報は、重要な内容を失わず読みやすい文章に整える。

元情報:
---
${originalText}
---`;
}

export async function organizeCompanyWithGemini({ originalText, signal, apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_MODEL }) {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません。'), { status: 503 });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildCompanyPrompt(originalText) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: COMPANY_SCHEMA,
        temperature: 0.1
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Gemini APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
  if (!text) throw Object.assign(new Error('Geminiから整理結果を取得できませんでした。'), { status: 502 });
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error('Geminiの応答をJSONとして解釈できませんでした。'), { status: 502 }); }
  const company = {
    name: String(parsed.name ?? '').trim(),
    url: String(parsed.url ?? '').trim(),
    info: String(parsed.info ?? '').trim()
  };
  if (!company.name || !company.info) throw Object.assign(new Error('Geminiの応答に企業情報が含まれていません。'), { status: 502 });
  return company;
}
