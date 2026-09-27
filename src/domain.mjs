import { randomUUID } from 'node:crypto';

export const DESTINATION_TYPES = new Set(['company', 'self', 'other']);

export function validateDestination(destination, companies) {
  if (!destination || !DESTINATION_TYPES.has(destination.type)) {
    throw httpError(400, '保存先を選択してください。');
  }
  if (destination.type === 'company') {
    if (!destination.companyId || !companies.some((company) => company.id === destination.companyId)) {
      throw httpError(400, '存在する企業を選択してください。');
    }
    return { type: 'company', companyId: destination.companyId };
  }
  return { type: destination.type, companyId: null };
}

export function normalizeCardInput(input, state, existing = null) {
  const title = String(input.title ?? '').trim();
  const body = String(input.body ?? '');
  if (!title) throw httpError(400, 'タイトルは必須です。');
  if (!body.trim()) throw httpError(400, '本文は必須です。');

  const categoryIds = [...new Set(Array.isArray(input.categoryIds) ? input.categoryIds : [])];
  if (categoryIds.some((id) => !state.categories.some((category) => category.id === id))) {
    throw httpError(400, '存在しないカテゴリーが含まれています。');
  }

  const eventDate = input.eventDate ? String(input.eventDate) : null;
  if (eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(new Date(`${eventDate}T12:00:00`).getTime()) || localDateString(new Date(`${eventDate}T12:00:00`)) !== eventDate)) {
    throw httpError(400, '日付の形式が正しくありません。');
  }
  if (!existing && input.isAiGenerated && [...body].length > 700) throw httpError(400, 'AI作成カードの本文は700文字以内にしてください。');

  const now = new Date().toISOString();
  const pinned = Boolean(input.pinned);
  return {
    id: existing?.id ?? randomUUID(),
    title,
    body,
    destination: validateDestination(input.destination, state.companies),
    categoryIds,
    eventDate,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    pinned,
    pinnedAt: pinned ? (existing?.pinned && existing.pinnedAt ? existing.pinnedAt : now) : null,
    originalText: input.isAiGenerated ? String(input.originalText ?? '') : null,
    isAiGenerated: Boolean(input.isAiGenerated)
  };
}

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isPastCard(card, today = localDateString()) {
  return Boolean(card.eventDate && card.eventDate < today);
}

export function sortPinnedCards(cards, mode = 'newest', today = localDateString()) {
  // Older callers passed the reference date as the second argument.
  if (/^\d{4}-\d{2}-\d{2}$/.test(mode)) { today = mode; mode = 'nearest'; }
  const dateGroup = (card) => !card.eventDate ? 1 : card.eventDate < today ? 2 : 0;
  return [...cards].filter((card) => card.pinned).sort((a, b) => {
    if (mode === 'nearest') {
      const aGroup = dateGroup(a);
      const bGroup = dateGroup(b);
      if (aGroup !== bGroup) return aGroup - bGroup;
      if (aGroup === 0) {
        const date = a.eventDate.localeCompare(b.eventDate);
        if (date) return date;
      }
    }
    const created = (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    return mode === 'oldest' ? -created : created;
  });
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
