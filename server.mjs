import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAppStore } from './src/create-store.mjs';
import { httpError, normalizeCardInput, sortPinnedCards } from './src/domain.mjs';
import { organizeCompanyWithGemini, organizeWithGemini } from './src/gemini.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_ROOT = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const store = await createAppStore();

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

export function createAppServer({ appStore = store, organizer = organizeWithGemini, companyOrganizer = organizeCompanyWithGemini } = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await appStore.refresh?.();
        return await handleApi(request, response, url, appStore, organizer, companyOrganizer);
      }
      return await serveStatic(response, url.pathname);
    } catch (error) {
      if (error.name === 'AbortError') return;
      sendJson(response, error.status || 500, { error: error.status ? error.message : 'サーバー内部でエラーが発生しました。' });
      if (!error.status) console.error(error);
    }
  });
}

async function handleApi(request, response, url, appStore, organizer, companyOrganizer) {
  const method = request.method;
  const path = url.pathname;
  if (method === 'GET' && path === '/api/data') {
    const state = appStore.snapshot();
    return sendJson(response, 200, {
      ...state,
      home: { pinned: sortPinnedCards(state.cards) }
    });
  }
  if (method === 'POST' && path === '/api/companies') {
    const input = await readJson(request);
    const name = String(input.name ?? '').trim();
    if (!name) throw httpError(400, '企業名は必須です。');
    const company = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString()
    };
    await appStore.update((state) => state.companies.push(company));
    return sendJson(response, 201, company);
  }
  if ((method === 'PATCH' || method === 'DELETE') && path.startsWith('/api/companies/')) {
    const id = decodeURIComponent(path.slice('/api/companies/'.length));
    if (method === 'PATCH') {
      const input = await readJson(request, Infinity);
      let company;
      await appStore.update((state) => {
        const index = state.companies.findIndex((item) => item.id === id);
        if (index < 0) throw httpError(404, '企業が見つかりません。');
        const name = String(input.name ?? state.companies[index].name).trim();
        if (!name) throw httpError(400, '企業名は必須です。');
        company = {
          ...state.companies[index],
          name,
          url: String(input.url ?? state.companies[index].url ?? '').trim(),
          info: String(input.info ?? state.companies[index].info ?? '')
        };
        state.companies[index] = company;
      });
      return sendJson(response, 200, company);
    }
    await appStore.update((state) => {
      const index = state.companies.findIndex((item) => item.id === id);
      if (index < 0) throw httpError(404, '企業が見つかりません。');
      state.companies.splice(index, 1);
      state.cards = state.cards.filter((card) => !(card.destination.type === 'company' && card.destination.companyId === id));
    });
    return sendJson(response, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/categories') {
    const input = await readJson(request);
    const name = String(input.name ?? '').trim();
    if (!name) throw httpError(400, 'カテゴリー名は必須です。');
    const category = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    await appStore.update((state) => {
      state.categories.push(category);
    });
    return sendJson(response, 201, category);
  }
  if (method === 'DELETE' && path.startsWith('/api/categories/')) {
    const id = decodeURIComponent(path.slice('/api/categories/'.length));
    await appStore.update((state) => {
      const index = state.categories.findIndex((item) => item.id === id);
      if (index < 0) throw httpError(404, 'カテゴリーが見つかりません。');
      state.categories.splice(index, 1);
      for (const card of state.cards) card.categoryIds = card.categoryIds.filter((categoryId) => categoryId !== id);
    });
    return sendJson(response, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/cards') {
    const input = await readJson(request, Infinity);
    let card;
    await appStore.update((state) => { card = normalizeCardInput(input, state); state.cards.push(card); });
    return sendJson(response, 201, card);
  }
  if (method === 'POST' && path === '/api/cards/batch') {
    const input = await readJson(request, Infinity);
    if (!Array.isArray(input.cards) || input.cards.length === 0) throw httpError(400, '保存するカードがありません。');
    let cards;
    await appStore.update((state) => { cards = input.cards.map((item) => normalizeCardInput(item, state)); state.cards.push(...cards); });
    return sendJson(response, 201, { cards });
  }
  if ((method === 'PATCH' || method === 'DELETE') && path.startsWith('/api/cards/')) {
    const id = decodeURIComponent(path.slice('/api/cards/'.length));
    if (method === 'DELETE') {
      await appStore.update((state) => {
        const index = state.cards.findIndex((item) => item.id === id);
        if (index < 0) throw httpError(404, 'カードが見つかりません。');
        state.cards.splice(index, 1);
      });
      return sendJson(response, 200, { ok: true });
    }
    const input = await readJson(request, Infinity);
    let card;
    await appStore.update((state) => {
      const index = state.cards.findIndex((item) => item.id === id);
      if (index < 0) throw httpError(404, 'カードが見つかりません。');
      card = normalizeCardInput({ ...state.cards[index], ...input }, state, state.cards[index]);
      state.cards[index] = card;
    });
    return sendJson(response, 200, card);
  }
  if (method === 'POST' && path === '/api/ai/organize') {
    const input = await readJson(request, 2_000_000);
    const originalText = await resolveSourceText(input);
    if (!originalText.trim()) throw httpError(400, '整理する元文章を入力してください。');
    const categories = appStore.snapshot().categories;
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    const drafts = await organizer({ originalText, categories, signal: controller.signal });
    return sendJson(response, 200, drafts);
  }
  if (method === 'POST' && path === '/api/ai/organize-company') {
    const input = await readJson(request, 2_000_000);
    const originalText = await resolveSourceText(input);
    if (!originalText.trim()) throw httpError(400, '整理する元情報を入力してください。');
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    const draft = await companyOrganizer({ originalText, signal: controller.signal });
    return sendJson(response, 200, draft);
  }
  throw httpError(404, 'APIが見つかりません。');
}

async function resolveSourceText(input) {
  const originalText = String(input.originalText ?? '').trim();
  const sourceUrl = String(input.sourceUrl ?? '').trim();
  if (originalText) return originalText;
  if (!sourceUrl) return '';
  let parsed;
  try { parsed = new URL(sourceUrl); } catch { throw httpError(400, 'WebページURLの形式が正しくありません。'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError(400, 'WebページURLの形式が正しくありません。');
  const fetched = await fetch(parsed, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'syukatsu-note/1.0' } });
  if (!fetched.ok) throw httpError(502, 'Webページを読み取れませんでした。');
  const contentType = fetched.headers.get('content-type') || '';
  if (!contentType.includes('text/')) throw httpError(400, 'このWebページは文章として読み取れません。');
  const text = await fetched.text();
  return text.slice(0, 1_500_000).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function readJson(request, limit = 5_000_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw httpError(413, '送信データが大きすぎます。');
  }
  try { return JSON.parse(body || '{}'); } catch { throw httpError(400, 'JSONの形式が正しくありません。'); }
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_ROOT, requested));
  if (!filePath.startsWith(PUBLIC_ROOT)) throw httpError(403, 'アクセスできません。');
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('not file');
    response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(await readFile(filePath));
  } catch {
    if (extname(pathname)) throw httpError(404, 'ファイルが見つかりません。');
    response.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
    response.end(await readFile(join(PUBLIC_ROOT, 'index.html')));
  }
}

function sendJson(response, status, value) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createAppServer().listen(PORT, () => console.log(`就活情報整理アプリ: http://localhost:${PORT}`));
}
